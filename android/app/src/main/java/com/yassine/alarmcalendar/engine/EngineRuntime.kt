package com.yassine.alarmcalendar.engine

import org.json.JSONException
import org.json.JSONObject

/**
 * [EngineCore] plus its storage and one lock. Every entry point of the app (the plugin, the alarm receiver, the
 * service, the alarm screen, the boot receiver) goes through one instance per process, so they never interleave:
 * each call loads nothing twice, mutates under the lock and writes the files it changed before returning.
 */
class EngineRuntime(
    private val storage: EngineStorage,
    private val clock: () -> Long,
    private val log: (String, Map<String, Any?>) -> Unit,
    newId: () -> String,
) {
    sealed class SetScheduleResult {
        class Accepted(val dropped: PayloadParser.Dropped, val dismissedOccurrenceIds: List<String>) : SetScheduleResult()
        class Rejected(val reason: String) : SetScheduleResult()
    }

    private val lock = Any()
    private val core: EngineCore

    init {
        val schedule = loadSchedule()
        val state = loadState()
        core = EngineCore(schedule, state, log, newId)
        // A fresh process cannot have an alarm on screen: whatever was ringing when the last one died rings again.
        core.recoverAfterRestart(clock())
        if (state.occurrences.isNotEmpty()) writeState()
    }

    private fun loadSchedule(): Schedule? {
        val text = storage.readSchedule() ?: return null
        return try {
            (PayloadParser.parse(JSONObject(text)) as? PayloadParser.Result.Accepted)?.schedule
                ?: run { storage.quarantineSchedule(); null }
        } catch (e: JSONException) {
            log("storage.schedule_unreadable", mapOf("error" to e.message))
            storage.quarantineSchedule()
            null
        }
    }

    private fun loadState(): EngineState {
        val text = storage.readState() ?: return EngineState()
        return try {
            StateCodec.fromJson(JSONObject(text))
        } catch (e: JSONException) {
            log("storage.state_unreadable", mapOf("error" to e.message))
            storage.quarantineState()
            EngineState()
        }
    }

    private fun writeState() = storage.writeState(StateCodec.toJson(core.state).toString())

    /**
     * Validates and stores a pushed schedule, then evaluates it (an occurrence inside the grace window rings at
     * once). A rejected payload leaves the previous schedule untouched.
     */
    fun setSchedule(payload: JSONObject): SetScheduleResult = synchronized(lock) {
        when (val parsed = PayloadParser.parse(payload)) {
            is PayloadParser.Result.Rejected -> {
                log("schedule.rejected", mapOf("reason" to parsed.reason))
                SetScheduleResult.Rejected(parsed.reason)
            }
            is PayloadParser.Result.Accepted -> {
                val now = clock()
                val result = core.setSchedule(parsed.schedule, now, parsed.retainedEventIds)
                // The schedule is written first: a crash between the two leaves state one step behind a newer
                // schedule, which the watermarks make harmless.
                storage.writeSchedule(PayloadParser.toJson(parsed.schedule).toString())
                core.evaluate(now)
                writeState()
                if (parsed.dropped.occurrences + parsed.dropped.eventInfo > 0) {
                    log("schedule.rows_dropped", mapOf("occurrences" to parsed.dropped.occurrences, "eventInfo" to parsed.dropped.eventInfo))
                }
                SetScheduleResult.Accepted(parsed.dropped, result.dismissedOccurrenceIds)
            }
        }
    }

    /** Rings what is due now. Returns the alarms to show, oldest first. */
    fun evaluate(): List<AlarmView> = synchronized(lock) {
        if (core.evaluate(clock())) writeState()
        core.activeRinging().map(core::viewOf)
    }

    fun activeRinging(): List<AlarmView> = synchronized(lock) { core.activeRinging().map(core::viewOf) }

    fun done(occurrenceId: String): Boolean = mutate { core.done(occurrenceId, it) }
    fun snooze(occurrenceId: String): Boolean = mutate { core.snooze(occurrenceId, it) }
    fun windowClosed(occurrenceId: String): Boolean = mutate { core.windowClosed(occurrenceId, it) }

    private fun mutate(action: (now: Long) -> Boolean): Boolean = synchronized(lock) {
        val changed = action(clock())
        if (changed) writeState()
        changed
    }

    fun nextTriggerAt(): Long? = synchronized(lock) { core.nextTriggerAt(clock()) }

    fun peekCompletions(): List<Completion> = synchronized(lock) { core.peekCompletions() }

    fun ackCompletions(ids: Collection<String>): Int = synchronized(lock) {
        val removed = core.ackCompletions(ids)
        if (removed > 0) writeState()
        removed
    }

    fun pendingDoneOccurrenceIds(): List<String> = synchronized(lock) { core.pendingDoneOccurrenceIds() }

    /** Claims today's horizon notice: true once per day while under 7 days of schedule remain. */
    fun takeHorizonNotice(): Boolean = synchronized(lock) {
        val now = clock()
        if (!core.horizonNoticeDue(now)) return@synchronized false
        core.recordHorizonNotice(now)
        writeState()
        true
    }

    fun horizonEndMs(): Long? = synchronized(lock) { core.schedule?.horizonEndMs }
    fun nextHorizonCheckAt(): Long? = synchronized(lock) { core.nextHorizonCheckAt(clock()) }
    fun settings(): EngineSettings? = synchronized(lock) { core.schedule?.settings }

    /** Forgets the schedule and every state (debug seed reset). */
    fun clear() = synchronized(lock) {
        core.schedule = null
        core.state.occurrences.clear()
        core.state.handledThrough.clear()
        core.state.pendingCompletions.clear()
        core.state.knownCompletions.clear()
        core.state.lastHorizonNoticeAtMs = 0L
        storage.clear()
    }

    /** State and the head of the schedule as text, for the debug dump. No titles or notes. */
    fun dump(): String = synchronized(lock) {
        val now = clock()
        val s = core.schedule
        val state = core.state
        buildString {
            append("now=").append(Instants.format(now)).append('\n')
            append("schedule=").append(if (s == null) "none" else "${s.occurrences.size} occurrences, horizonEnd=${Instants.format(s.horizonEndMs)}, truncated=${s.truncated}").append('\n')
            append("nextTrigger=").append(core.nextTriggerAt(now)?.let(Instants::format) ?: "none").append('\n')
            for (o in state.occurrences) {
                append("state ").append(o.occurrenceId).append(" phase=").append(o.phase).append(" snoozesUsed=").append(o.snoozesUsed)
                append(" wakeAt=").append(o.wakeAtMs?.let(Instants::format) ?: "-").append('\n')
            }
            append("pendingCompletions=").append(state.pendingCompletions.size).append('\n')
            append("knownCompletions=").append(state.knownCompletions.size).append('\n')
            s?.occurrences?.filter { it.atMs >= now - 3_600_000L }?.take(5)?.forEach {
                append("next ").append(it.id).append(" silenced=").append(it.silenced).append(" completed=").append(it.completed).append('\n')
            }
        }
    }
}
