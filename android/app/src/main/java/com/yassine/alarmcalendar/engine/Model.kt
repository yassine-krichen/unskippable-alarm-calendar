package com.yassine.alarmcalendar.engine

/**
 * The engine's view of the schedule push (SchedulePayload version 2, see packages/core) and of its own
 * state. Instants are epoch milliseconds in memory; occurrence instants also keep the original ISO text,
 * which is part of the occurrence id and of the completion row.
 */

data class EngineSettings(
    val userId: String,
    val timezone: String,
    val graceMinutes: Int,
    val refireSeconds: Int,
    val sound: String?,
    val prayerSound: String?,
)

data class UnloggedLabel(val id: String, val label: String)

data class ScheduleOccurrence(
    val id: String,
    val eventId: String,
    val at: String,
    val atMs: Long,
    val silenced: Boolean,
    val completed: Boolean,
    val originalAt: String?,
    val originalAtMs: Long?,
    val label: String?,
    val labelIfUnlogged: UnloggedLabel?,
)

data class EventInfo(
    val title: String,
    val notes: String?,
    val maxSnoozes: Int,
    val snoozeMinutes: Int,
    val soundId: String?,
    val kind: String?,
    val prayer: String?,
)

class Schedule(
    val generatedAtMs: Long,
    val horizonEndMs: Long,
    val truncated: Boolean,
    val settings: EngineSettings,
    /** Ascending by instant, then event id. */
    val occurrences: List<ScheduleOccurrence>,
    /** One entry per active event; a ringing alarm whose event is missing here is dismissed. */
    val eventInfo: Map<String, EventInfo>,
)

enum class Phase { RINGING, SNOOZED }

/**
 * Local state of an occurrence that has started ringing and is not Done. It carries its own copy of the text and
 * the snooze rules: the list drops an occurrence once it is older than the grace window, while a snooze or an
 * unanswered alarm outlives that. `wakeAtMs == null` while RINGING means the alarm is on screen now; with a value
 * it is waiting to ring again after the screen went away without a choice.
 */
class OccurrenceState(
    val eventId: String,
    val occurrenceAt: String,
    var snoozesUsed: Int,
    var phase: Phase,
    var wakeAtMs: Long?,
    val userId: String,
    var title: String,
    var notes: String?,
    var maxSnoozes: Int,
    var snoozeMinutes: Int,
    var soundId: String?,
    var kind: String?,
    /** True when `title` is the occurrence's own text (a pre-prayer label), not the event's title. */
    var labelled: Boolean,
) {
    val occurrenceId: String get() = "$eventId@$occurrenceAt"
    val occurrenceAtMs: Long get() = Instants.parse(occurrenceAt) ?: 0L
}

/** A completion row as the app upserts it into Supabase (snake_case keys in JSON). */
data class Completion(
    val id: String,
    val userId: String,
    val eventId: String,
    val occurrenceAt: String,
    val status: String,
    val snoozesUsed: Int,
    val doneAt: String,
)

/** Everything except the schedule that must survive a process death. */
class EngineState(
    val occurrences: MutableList<OccurrenceState> = mutableListOf(),
    /** Per event, the latest occurrence instant already rung, silenced or dropped. */
    val handledThrough: MutableMap<String, Long> = mutableMapOf(),
    val pendingCompletions: MutableList<Completion> = mutableListOf(),
    /** Occurrence ids known to be completed (on this or any device), kept for 7 days. */
    var knownCompletions: MutableList<String> = mutableListOf(),
    var lastHorizonNoticeAtMs: Long = 0L,
)

/** What the alarm screen shows. */
data class AlarmView(
    val occurrenceId: String,
    val title: String,
    val notes: String?,
    val occurrenceAt: String,
    val occurrenceAtMs: Long,
    val snoozeLabel: String?,
    val snoozeNotice: String?,
    val soundId: String?,
    val kind: String?,
    val snoozesUsed: Int,
    val snoozesLeft: Int,
)
