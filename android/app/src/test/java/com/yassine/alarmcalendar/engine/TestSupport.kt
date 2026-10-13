package com.yassine.alarmcalendar.engine

import org.json.JSONArray
import org.json.JSONObject

/** Storage in memory, so the engine tests need no files; `failNextWrite` simulates a crash before the rename. */
class MemoryStorage : EngineStorage {
    var schedule: String? = null
    var state: String? = null
    val quarantined = mutableListOf<String>()

    override fun readSchedule() = schedule
    override fun writeSchedule(json: String) { schedule = json }
    override fun readState() = state
    override fun writeState(json: String) { state = json }
    override fun quarantineSchedule() { quarantined.add("schedule"); schedule = null }
    override fun quarantineState() { quarantined.add("state"); state = null }
    override fun clear() { schedule = null; state = null }
}

object Fixtures {
    const val USER = "99999999-9999-4999-8999-999999999999"
    const val EVENT_A = "11111111-1111-4111-8111-111111111111"
    const val EVENT_B = "22222222-2222-4222-8222-222222222222"
    const val BASE = "2026-03-02T09:00:00.000Z"
    val baseMs: Long = Instants.parse(BASE)!!

    fun at(offsetSeconds: Long): String = Instants.format(baseMs + offsetSeconds * 1000)

    fun occurrence(eventId: String, offsetSeconds: Long, extra: (JSONObject) -> Unit = {}): JSONObject {
        val at = at(offsetSeconds)
        return JSONObject().put("id", "$eventId@$at").put("eventId", eventId).put("at", at)
            .put("silenced", false).put("completed", false).also(extra)
    }

    fun info(title: String = "Take medication", maxSnoozes: Int = 2, snoozeMinutes: Int = 5): JSONObject =
        JSONObject().put("title", title).put("notes", JSONObject.NULL).put("maxSnoozes", maxSnoozes)
            .put("snoozeMinutes", snoozeMinutes).put("soundId", JSONObject.NULL)

    fun settings(graceMinutes: Int = 30, refireSeconds: Int = 120): JSONObject =
        JSONObject().put("user_id", USER).put("timezone", "UTC").put("week_starts_on", 0).put("pass_cap", 2)
            .put("grace_minutes", graceMinutes).put("refire_seconds", refireSeconds)

    fun payload(
        occurrences: List<JSONObject>,
        eventInfo: Map<String, JSONObject>,
        settings: JSONObject = settings(),
        generatedAtMs: Long = baseMs,
        horizonDays: Long = 60,
    ): JSONObject {
        val info = JSONObject()
        for ((id, value) in eventInfo) info.put(id, value)
        return JSONObject()
            .put("version", 2)
            .put("generatedAt", Instants.format(generatedAtMs))
            .put("horizonEnd", Instants.format(generatedAtMs + horizonDays * Instants.MS_PER_DAY))
            .put("truncated", false)
            .put("settings", settings)
            .put("occurrences", JSONArray(occurrences))
            .put("eventInfo", info)
    }

    fun accepted(payload: JSONObject): PayloadParser.Result.Accepted =
        PayloadParser.parse(payload) as PayloadParser.Result.Accepted
}

/** An engine over [MemoryStorage] with a clock the test moves by hand. */
class Rig(val storage: MemoryStorage = MemoryStorage(), startMs: Long = Fixtures.baseMs) {
    var now: Long = startMs
    val logs = mutableListOf<String>()
    private var idCounter = 0
    var runtime = create()

    private fun create() = EngineRuntime(storage, { now }, { event, _ -> logs.add(event) }, { "00000000-0000-4000-8000-%012d".format(++idCounter) })

    /** A new process: same files, fresh memory. */
    fun restart() { runtime = create() }

    /** Moves time forward the way AlarmManager would: waking the engine at every trigger on the way. */
    fun advanceTo(targetMs: Long) {
        var guard = 0
        while (guard++ < 1000) {
            val next = runtime.nextTriggerAt() ?: break
            if (next > targetMs) break
            now = maxOf(now, next)
            runtime.evaluate()
        }
        now = targetMs
        runtime.evaluate()
    }

    fun advanceBy(seconds: Long) = advanceTo(now + seconds * 1000)
}
