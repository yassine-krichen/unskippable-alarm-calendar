package com.yassine.alarmcalendar.engine

/**
 * The alarm decision logic, a port of electron/src/scheduler.ts without its timers, windows and refill: it rings
 * what is in the precomputed list and applies no recurrence, cheat day, mode or prayer-time rules. No Android
 * classes and no clock of its own (every method takes `now`), so it runs in plain JVM tests.
 *
 * Differences from electron, all because Android has no 30 second loop and no window of its own:
 * - Nothing arms a timer here. [nextTriggerAt] says when the host must wake the engine (AlarmManager).
 * - [windowClosed] is what the alarm screen reports when it went away without a choice.
 * - A prayer completion is matched by exact instant only (core's prayer-day matching needs prayer times). The list's
 *   `completed` flag carries the prayer-day match from the moment the app built the list.
 *
 * Not thread safe; [EngineRuntime] serialises access.
 */
class EngineCore(
    var schedule: Schedule?,
    val state: EngineState,
    private val log: (String, Map<String, Any?>) -> Unit,
    private val newId: () -> String,
) {
    companion object {
        /** Far longer than any grace window, short enough that the state cannot grow without bound. */
        const val KNOWN_COMPLETION_RETENTION_MS = 7 * Instants.MS_PER_DAY
        const val FALLBACK_REFIRE_SECONDS = 120
        /** Floor of the grace window, so an on-time alarm that is delivered slightly late still rings. */
        const val DELIVERY_TOLERANCE_MS = 60_000L
        /** Fewer days of horizon than this and the user is asked to open the app (the engine cannot expand recurrences). */
        const val HORIZON_WARNING_MS = 7 * Instants.MS_PER_DAY
        /** At most one horizon notice per this long. */
        const val HORIZON_NOTICE_GAP_MS = 24 * 60 * Instants.MS_PER_MINUTE

        // Prayer windows (mirrors PRAYER_* in packages/core/src/prayer-times.ts; the shared vectors pin both).
        /** Later offers these many minutes, each only while it still ends [PRAYER_LATER_MARGIN_MS] before the window does. */
        val PRAYER_LATER_MINUTES: List<Int> = listOf(20, 40, 60)
        const val PRAYER_FINAL_CALL_MS = 20 * Instants.MS_PER_MINUTE
        const val PRAYER_LATER_MARGIN_MS = 10 * Instants.MS_PER_MINUTE
        const val CANT_NOW_UNTIL_LAST_CALL = "until_last_call"
        const val CANT_NOW_GIVE_UP = "give_up"

        /** When the last call rings: 20 minutes before the window ends, or halfway through a shorter window. */
        fun finalCallAt(atMs: Long, windowEndMs: Long): Long =
            windowEndMs - minOf(PRAYER_FINAL_CALL_MS, (windowEndMs - atMs) / 2)

        /** The Later buttons a prayer offers at `now` (see prayerDeferralChoices in core). */
        fun laterChoices(windowEndMs: Long, now: Long): List<Int> =
            PRAYER_LATER_MINUTES.filter { now + it * Instants.MS_PER_MINUTE <= windowEndMs - PRAYER_LATER_MARGIN_MS }

        /**
         * The next instant at which what a prayer's screen shows changes by itself: a Later option stops fitting, or
         * Can't now turns into the give-up button (a minute before the last call). Null when nothing is left to change.
         * The screen redraws from the engine then, so a stale button is never left on screen.
         */
        fun nextChoiceChangeAt(view: AlarmView, now: Long): Long? {
            val windowEnd = view.windowEndMs ?: return null
            val boundaries = ArrayList<Long>()
            val lastCallAt = view.lastCallAtMs
            if (view.cantNow == CANT_NOW_UNTIL_LAST_CALL && lastCallAt != null) boundaries.add(lastCallAt - Instants.MS_PER_MINUTE)
            // An option is offered while now + minutes <= end - 10 min, so it is gone one millisecond after that.
            for (minutes in view.laterMinutes ?: emptyList()) boundaries.add(windowEnd - PRAYER_LATER_MARGIN_MS - minutes * Instants.MS_PER_MINUTE + 1)
            return boundaries.filter { it > now }.minOrNull()
        }

        /** 'give_up' from a minute before the last call on, or when this ring already is the last call. */
        fun cantNowChoice(atMs: Long, windowEndMs: Long, now: Long, lastCall: Boolean): String =
            if (lastCall || now >= finalCallAt(atMs, windowEndMs) - Instants.MS_PER_MINUTE) CANT_NOW_GIVE_UP else CANT_NOW_UNTIL_LAST_CALL
    }

    /** What the host must do after a [setSchedule]. */
    class SetResult(val dismissedOccurrenceIds: List<String>)

    /**
     * A process that was killed while an alarm was on screen has no screen any more: ring it again at once instead
     * of waiting out a refire delay (electron does the same in start()). Call once when the process loads the state.
     */
    fun recoverAfterRestart(now: Long) {
        for (s in state.occurrences) {
            if (s.phase == Phase.RINGING && s.wakeAtMs == null) {
                s.wakeAtMs = now
            } else if (s.phase == Phase.SNOOZED && s.wakeAtMs == null) {
                // A snooze with no wake-up time can only come from a damaged file; ringing is the safe reading.
                s.phase = Phase.RINGING
                s.wakeAtMs = now
            }
        }
    }

    /**
     * Replaces the stored schedule. Completions flagged in the new list are merged into the known ones, never
     * replacing them: a completion seen once stays known until it ages out, even if a later push flags fewer.
     */
    fun setSchedule(next: Schedule, now: Long, retainedEventIds: Set<String> = emptySet()): SetResult {
        schedule = next
        if (next.truncated) {
            log("schedule.truncated", mapOf("occurrences" to next.occurrences.size, "horizonEnd" to Instants.format(next.horizonEndMs)))
        }
        mergeKnownCompletions(next.occurrences.filter { it.completed }.map { it.id }, now)

        // An alarm whose event was deleted or switched off is dismissed; one that merely left the list is not, and
        // neither is one whose event info was unusable in this push (the key says it still exists).
        val gone = state.occurrences.filter { !next.eventInfo.containsKey(it.eventId) && it.eventId !in retainedEventIds }
        state.occurrences.removeAll(gone.toSet())
        refreshStatesFromSchedule(next)
        state.handledThrough.keys.retainAll(next.eventInfo.keys + retainedEventIds)
        return SetResult(gone.map { it.occurrenceId })
    }

    /** An edit that lands while an alarm is ringing or snoozed (new title, snooze rules) applies to it. */
    private fun refreshStatesFromSchedule(next: Schedule) {
        var byId: Map<String, ScheduleOccurrence>? = null
        for (s in state.occurrences) {
            val info = next.eventInfo[s.eventId] ?: continue
            if (s.labelled) {
                val index = byId ?: next.occurrences.associateBy { it.id }.also { byId = it }
                val occurrence = index[s.occurrenceId]
                if (occurrence != null) s.title = textFor(occurrence, info).first
            } else {
                s.title = info.title
            }
            s.notes = info.notes
            s.maxSnoozes = info.maxSnoozes
            s.snoozeMinutes = info.snoozeMinutes
            s.soundId = info.soundId
            s.kind = info.kind
        }
    }

    /**
     * What an occurrence says when it rings. Its own label if it has one; if it says "unless this other occurrence
     * is completed" (a pre-prayer alarm whose previous prayer was still to come when the list was built), the
     * alternative text applies when that one is not known to be completed now. Returns (text, labelled).
     */
    private fun textFor(occurrence: ScheduleOccurrence, info: EventInfo): Pair<String, Boolean> {
        val unlogged = occurrence.labelIfUnlogged
        if (unlogged != null) {
            val previous = Instants.parseOccurrenceId(unlogged.id)
            if (previous != null && !isKnownCompleted(previous.eventId, previous.atMs)) return unlogged.label to true
        }
        occurrence.label?.let { return it to true }
        return info.title to false
    }

    private fun mergeKnownCompletions(ids: Collection<String>, now: Long) {
        val cutoff = now - KNOWN_COMPLETION_RETENTION_MS
        val merged = LinkedHashSet<String>(state.knownCompletions)
        merged.addAll(ids)
        state.knownCompletions = merged.filterTo(ArrayList()) { id ->
            val parsed = Instants.parseOccurrenceId(id)
            parsed != null && parsed.atMs >= cutoff
        }
    }

    /** Done on this device (not yet drained) or already synced from any device. Exact instant. */
    private fun isKnownCompleted(eventId: String, atMs: Long): Boolean {
        val id = Instants.makeOccurrenceId(eventId, atMs)
        return state.knownCompletions.contains(id) ||
            state.pendingCompletions.any { it.eventId == eventId && Instants.parse(it.occurrenceAt) == atMs }
    }

    /**
     * Re-checks everything against the clock: wakes snoozed and re-firing alarms, rings due occurrences. Returns
     * true when the state changed (the caller persists it). The host then reads [activeRinging].
     */
    fun evaluate(now: Long): Boolean {
        // First: a prayer whose time is over must not ring or wake again, whatever else is due.
        val closed = closeExpiredPrayerWindows(now)
        val woke = wakeWaitingOccurrences(now)
        val rang = ringDueOccurrences(now)
        if (woke || rang) log("scheduler.evaluated", emptyMap())
        return closed || woke || rang
    }

    /**
     * A prayer's time is over at its window end: any ringing or snoozed state of it goes and nothing is recorded (it
     * is missed from here on, and can be made up). The host sees it leave [activeRinging] and closes the screen.
     */
    private fun closeExpiredPrayerWindows(now: Long): Boolean {
        val expired = state.occurrences.filter { val end = it.windowEndMs; end != null && end <= now }
        if (expired.isEmpty()) return false
        state.occurrences.removeAll(expired.toSet())
        for (s in expired) log("alarm.window_closed", mapOf("eventId" to s.eventId, "occurrenceAt" to s.occurrenceAt))
        return true
    }

    /** Alarms on screen (or to be put on screen) now, oldest first. */
    fun activeRinging(): List<OccurrenceState> =
        state.occurrences
            .filter { it.phase == Phase.RINGING && it.wakeAtMs == null }
            .sortedWith(compareBy<OccurrenceState> { it.occurrenceAtMs }.thenBy { it.eventId })

    fun viewOf(s: OccurrenceState, now: Long): AlarmView {
        val windowEnd = s.windowEndMs
        // A prayer with a window offers Later / Can't now instead of snoozes.
        if (windowEnd != null) {
            return AlarmView(
                s.occurrenceId, s.title, s.notes, s.occurrenceAt, s.occurrenceAtMs, null, null, s.soundId, s.kind, s.snoozesUsed, 0,
                laterMinutes = laterChoices(windowEnd, now),
                cantNow = cantNowChoice(s.occurrenceAtMs, windowEnd, now, s.lastCall),
                windowEndMs = windowEnd,
                lastCallAtMs = finalCallAt(s.occurrenceAtMs, windowEnd),
            )
        }
        val left = maxOf(0, s.maxSnoozes - s.snoozesUsed)
        // With max_snoozes = 0 no snooze was ever offered, so there is nothing to explain.
        val label = if (left > 0) "Snooze ${s.snoozeMinutes} min · $left left" else null
        val notice = if (left == 0 && s.maxSnoozes > 0) "No snoozes left, do it now" else null
        return AlarmView(s.occurrenceId, s.title, s.notes, s.occurrenceAt, s.occurrenceAtMs, label, notice, s.soundId, s.kind, s.snoozesUsed, left)
    }

    /** Records a pending completion and ends the occurrence. False if it was not ringing. */
    fun done(occurrenceId: String, now: Long): Boolean {
        val s = findRingingState(occurrenceId) ?: return false
        val completion = Completion(
            id = newId(),
            userId = s.userId,
            eventId = s.eventId,
            occurrenceAt = s.occurrenceAt,
            status = "done",
            snoozesUsed = s.snoozesUsed,
            doneAt = Instants.format(now),
        )
        // Upserts are keyed by (event_id, occurrence_at), so keep one pending row per key.
        state.pendingCompletions.removeAll { it.eventId == completion.eventId && it.occurrenceAt == completion.occurrenceAt }
        state.pendingCompletions.add(completion)
        // Known at once, so the drain below cannot make this occurrence ring again after a stale push.
        mergeKnownCompletions(listOf(s.occurrenceId), now)
        state.occurrences.remove(s)
        advanceHandledThrough(s.eventId, s.occurrenceAtMs)
        log("alarm.done", mapOf("occurrenceId" to occurrenceId, "snoozesUsed" to s.snoozesUsed))
        evaluate(now)
        return true
    }

    /** Snoozes if the occurrence still allows it. False if it was not ringing or no snoozes are left. */
    fun snooze(occurrenceId: String, now: Long): Boolean {
        val s = findRingingState(occurrenceId) ?: return false
        // A prayer with a window has Later / Can't now instead of snoozes, whatever the rules say.
        if (s.windowEndMs != null || s.maxSnoozes - s.snoozesUsed <= 0) return false
        s.snoozesUsed += 1
        s.phase = Phase.SNOOZED
        s.wakeAtMs = now + s.snoozeMinutes * Instants.MS_PER_MINUTE
        log("alarm.snoozed", mapOf("occurrenceId" to occurrenceId, "snoozesUsed" to s.snoozesUsed))
        evaluate(now)
        return true
    }

    /**
     * Later on a prayer with a window: quiet for `minutes` (one of [PRAYER_LATER_MINUTES], and only while it still ends
     * 10 minutes before the window does), then ring again. Unlimited and not counted as a snooze. False if the
     * occurrence is not ringing, has no window, or that choice no longer fits.
     */
    fun later(occurrenceId: String, minutes: Int, now: Long): Boolean {
        val s = findRingingState(occurrenceId) ?: return false
        val windowEnd = s.windowEndMs ?: return false
        if (minutes !in laterChoices(windowEnd, now)) return false
        s.phase = Phase.SNOOZED
        s.wakeAtMs = now + minutes * Instants.MS_PER_MINUTE
        log("alarm.later", mapOf("occurrenceId" to occurrenceId, "minutes" to minutes))
        evaluate(now)
        return true
    }

    /**
     * Can't now on a prayer with a window. Before the last call it quiets the prayer until then (and the next Can't now
     * gives up); from a minute before the last call on, or at the last call itself, it ends the alarm with no
     * completion: the prayer becomes missed when the window closes, and can be made up afterwards (qada). False if the
     * occurrence is not ringing or has no window.
     */
    fun cantNow(occurrenceId: String, shown: String, now: Long): Boolean {
        val s = findRingingState(occurrenceId) ?: return false
        val windowEnd = s.windowEndMs ?: return false
        val choice = cantNowChoice(s.occurrenceAtMs, windowEnd, now, s.lastCall)
        // The button pressed said one thing; if the clock has made it the other, do nothing and let the screen redraw.
        // Otherwise a stale "Can't now · last call" would give the prayer up without the person seeing that.
        if (choice != shown) {
            log("alarm.cant_now_refused", mapOf("occurrenceId" to occurrenceId, "shown" to shown, "now" to choice))
            return false
        }
        if (choice == CANT_NOW_GIVE_UP) {
            state.occurrences.remove(s)
            log("alarm.gave_up", mapOf("occurrenceId" to occurrenceId))
        } else {
            s.phase = Phase.SNOOZED
            s.lastCall = true
            s.wakeAtMs = finalCallAt(s.occurrenceAtMs, windowEnd)
            log("alarm.cant_now", mapOf("occurrenceId" to occurrenceId, "lastCallAt" to Instants.format(s.wakeAtMs!!)))
        }
        evaluate(now)
        return true
    }

    /** The alarm screen went away. If no choice was made, schedule the re-ring. */
    fun windowClosed(occurrenceId: String, now: Long): Boolean {
        val s = findRingingState(occurrenceId) ?: return false
        if (s.wakeAtMs != null) return false
        val refireSeconds = schedule?.settings?.refireSeconds ?: FALLBACK_REFIRE_SECONDS
        s.wakeAtMs = now + refireSeconds * 1000L
        log("alarm.closed_without_choice", mapOf("occurrenceId" to occurrenceId, "refireAt" to Instants.format(s.wakeAtMs!!)))
        evaluate(now)
        return true
    }

    /** The completions made here that the app has not acknowledged yet. They stay until [ackCompletions]. */
    fun peekCompletions(): List<Completion> = ArrayList(state.pendingCompletions)

    /** Forgets completions (by row id) the app has saved. Returns how many were removed; unknown ids are ignored. */
    fun ackCompletions(ids: Collection<String>): Int {
        val acknowledged = ids.toSet()
        val before = state.pendingCompletions.size
        state.pendingCompletions.removeAll { it.id in acknowledged }
        return before - state.pendingCompletions.size
    }

    /** Occurrence ids marked Done here that the app has not acknowledged yet. */
    fun pendingDoneOccurrenceIds(): List<String> =
        state.pendingCompletions.map { "${it.eventId}@${it.occurrenceAt}" }

    /**
     * When the host must wake the engine next: the soonest of every wake-up time of a snoozed or re-firing alarm
     * and the first occurrence its event has not handled yet that is not older than the grace window. The result
     * can be in the past (something is due now, e.g. after a reboot); the host then fires at once. After an
     * [evaluate] nothing at or before `now` is left unhandled, so this cannot spin.
     */
    fun nextTriggerAt(now: Long): Long? {
        var soonest = Long.MAX_VALUE
        for (s in state.occurrences) {
            s.wakeAtMs?.let { soonest = minOf(soonest, it) }
            // A prayer's window closing is an event of its own: it dismisses the state.
            s.windowEndMs?.let { soonest = minOf(soonest, it) }
        }
        val current = schedule
        if (current != null) {
            val graceStart = now - graceMsOf(current.settings)
            val list = current.occurrences
            for (i in firstAtOrAfter(list, graceStart) until list.size) {
                val o = list[i]
                val watermark = state.handledThrough[o.eventId]
                if (watermark != null && o.atMs <= watermark) continue
                soonest = minOf(soonest, o.atMs)
                break
            }
        }
        return if (soonest == Long.MAX_VALUE) null else soonest
    }

    /** True when the list is running out and the user has not been told today. */
    fun horizonNoticeDue(now: Long): Boolean {
        val current = schedule ?: return false
        return current.horizonEndMs - now < HORIZON_WARNING_MS && now - state.lastHorizonNoticeAtMs >= HORIZON_NOTICE_GAP_MS
    }

    fun recordHorizonNotice(now: Long) {
        state.lastHorizonNoticeAtMs = now
    }

    /** When to look at the horizon again: when it first drops under the warning, or when the daily notice may repeat. */
    fun nextHorizonCheckAt(now: Long): Long? {
        val current = schedule ?: return null
        val warnAt = current.horizonEndMs - HORIZON_WARNING_MS
        if (warnAt > now) return warnAt
        return maxOf(now + 60_000L, state.lastHorizonNoticeAtMs + HORIZON_NOTICE_GAP_MS)
    }

    private fun wakeWaitingOccurrences(now: Long): Boolean {
        var changed = false
        for (s in ArrayList(state.occurrences)) {
            val wake = s.wakeAtMs ?: continue
            if (wake > now) continue
            s.phase = Phase.RINGING
            s.wakeAtMs = null
            changed = true
            log("alarm.ringing_again", mapOf("eventId" to s.eventId))
        }
        return changed
    }

    private fun ringDueOccurrences(now: Long): Boolean {
        val current = schedule ?: return false
        // Only the grace window and the watermark matter: walk the occurrences due now and keep the latest per
        // event. After a long sleep several can be due; only the latest is worth ringing.
        val graceStart = now - graceMsOf(current.settings)
        val list = current.occurrences
        val latestByEvent = LinkedHashMap<String, ScheduleOccurrence>()
        for (i in firstAtOrAfter(list, graceStart) until list.size) {
            val o = list[i]
            if (o.atMs > now) break
            val watermark = state.handledThrough[o.eventId]
            if (watermark != null && o.atMs <= watermark) continue
            latestByEvent[o.eventId] = o
        }
        var changed = false
        for (o in latestByEvent.values) changed = handleLatestDue(current, o, now) || changed
        return changed
    }

    /** Rings, silences or drops the latest due occurrence of one event. Returns true if the state changed. */
    private fun handleLatestDue(current: Schedule, o: ScheduleOccurrence, now: Long): Boolean {
        advanceHandledThrough(o.eventId, o.atMs)
        // Done on another device (flagged in the list or synced earlier) or here (pending): do not ring it again on
        // resume. A shifted occurrence is also done if it was done at the time it had before the shift.
        val alreadyCompleted = o.completed ||
            isKnownCompleted(o.eventId, o.atMs) ||
            (o.originalAtMs != null && isKnownCompleted(o.eventId, o.originalAtMs))
        val lateMs = now - o.atMs
        val withinGrace = lateMs >= 0 && lateMs <= graceMsOf(current.settings)
        if (alreadyCompleted || !withinGrace) {
            if (alreadyCompleted) log("alarm.skipped_already_completed", mapOf("eventId" to o.eventId))
            return true
        }
        if (o.silenced) {
            log("alarm.silenced_by_cheat_day", mapOf("eventId" to o.eventId))
            return true
        }
        // A prayer whose time is already over (the device slept through it, or restarted after it) does not ring.
        if (o.windowEndMs != null && o.windowEndMs <= now) {
            log("alarm.skipped_window_closed", mapOf("eventId" to o.eventId))
            return true
        }
        // A new occurrence of an event that is still ringing is dropped. A snoozed occurrence is part of the same
        // ringing lifecycle, so it counts too.
        if (state.occurrences.any { it.eventId == o.eventId }) {
            log("alarm.dropped_already_ringing", mapOf("eventId" to o.eventId))
            return true
        }
        val info = current.eventInfo[o.eventId]
        if (info == null) {
            // Cannot happen for a list that passed the parser; never ring blind.
            log("scheduler.event_info_missing", mapOf("eventId" to o.eventId))
            return true
        }
        val (title, labelled) = textFor(o, info)
        state.occurrences.add(
            OccurrenceState(
                eventId = o.eventId,
                occurrenceAt = o.at,
                snoozesUsed = 0,
                phase = Phase.RINGING,
                wakeAtMs = null,
                userId = current.settings.userId,
                title = title,
                notes = info.notes,
                maxSnoozes = info.maxSnoozes,
                snoozeMinutes = info.snoozeMinutes,
                soundId = info.soundId,
                kind = info.kind,
                labelled = labelled,
                windowEndMs = o.windowEndMs,
            )
        )
        log("alarm.ringing", mapOf("eventId" to o.eventId, "occurrenceAt" to o.at))
        return true
    }

    private fun advanceHandledThrough(eventId: String, atMs: Long) {
        val current = state.handledThrough[eventId]
        if (current == null || current < atMs) state.handledThrough[eventId] = atMs
    }

    private fun findRingingState(occurrenceId: String): OccurrenceState? {
        val parsed = Instants.parseOccurrenceId(occurrenceId) ?: return null
        return state.occurrences.firstOrNull {
            it.eventId == parsed.eventId && it.occurrenceAt == parsed.occurrenceAt && it.phase == Phase.RINGING
        }
    }

    /**
     * The grace window the list can serve (core's look-back caps it), never under the delivery tolerance: an alarm is
     * never delivered at the exact millisecond, so even grace_minutes = 0 must ring an occurrence that is a moment late.
     */
    private fun graceMsOf(settings: EngineSettings): Long =
        maxOf(minOf(settings.graceMinutes, PayloadParser.MAX_LOOKBACK_MINUTES) * Instants.MS_PER_MINUTE, DELIVERY_TOLERANCE_MS)

    /** Index of the first occurrence at or after `ms` in a list ascending by time. */
    private fun firstAtOrAfter(list: List<ScheduleOccurrence>, ms: Long): Int {
        var low = 0
        var high = list.size
        while (low < high) {
            val middle = (low + high) ushr 1
            if (list[middle].atMs < ms) low = middle + 1 else high = middle
        }
        return low
    }
}
