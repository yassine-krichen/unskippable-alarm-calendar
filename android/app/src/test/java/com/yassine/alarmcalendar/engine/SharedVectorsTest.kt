package com.yassine.alarmcalendar.engine

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/**
 * Runs packages/core/test-vectors/alarm-engine.json, the scenarios electron/src/engine-vectors.test.ts runs against
 * the reference scheduler, through the Kotlin engine. A scenario that passes there and fails here is a porting bug.
 */
@RunWith(Parameterized::class)
class SharedVectorsTest(private val name: String, private val scenario: JSONObject) {
    companion object {
        private val root: JSONObject = run {
            // Gradle runs unit tests with the module directory (android/app) as the working directory.
            val file = File("../../packages/core/test-vectors/alarm-engine.json")
            check(file.isFile) { "shared vectors not found at ${file.absolutePath}" }
            JSONObject(file.readText())
        }
        private val events: JSONObject = root.getJSONObject("events")

        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun scenarios(): List<Array<Any>> {
            val array = root.getJSONArray("scenarios")
            return (0 until array.length()).map { arrayOf(array.getJSONObject(it).getString("name"), array.getJSONObject(it)) }
        }

        private fun idOf(key: String): String = events.getString(key)
        private fun keyOf(eventId: String): String = events.keys().asSequence().first { events.getString(it) == eventId }
    }

    @Test
    fun matchesTheReferenceEngine() {
        val rig = Rig(startMs = Instants.parse(scenario.getString("start"))!!)
        val settings = scenario.getJSONObject("settings")
        push(rig, scenario, settings)

        val steps = scenario.getJSONArray("steps")
        for (i in 0 until steps.length()) {
            val step = steps.getJSONObject(i)
            val where = "$name @ ${step.getString("at")}"
            rig.advanceTo(Instants.parse(step.getString("at"))!!)
            step.optJSONObject("push")?.let { push(rig, it, settings) }
            if (step.has("action")) {
                val eventId = idOf(step.getString("event"))
                val id = rig.runtime.activeRinging().firstOrNull { it.occurrenceId.startsWith(eventId) }?.occurrenceId ?: "$eventId@none"
                when (step.getString("action")) {
                    "done" -> rig.runtime.done(id)
                    "snooze" -> rig.runtime.snooze(id)
                    "close" -> rig.runtime.windowClosed(id)
                    "later" -> rig.runtime.later(id, step.getInt("minutes"))
                    "cantNow" -> rig.runtime.cantNow(
                        id,
                        if (step.has("variant")) step.getString("variant") else rig.runtime.activeRinging().firstOrNull { it.occurrenceId == id }?.cantNow ?: EngineCore.CANT_NOW_UNTIL_LAST_CALL,
                    )
                    else -> error("unknown action")
                }
            }
            if (step.has("ringing")) {
                val expectedArray = step.getJSONArray("ringing")
                // laterMinutes and cantNow are compared only for a row that names them (null: no prayer choices).
                val named = (0 until expectedArray.length()).map { expectedArray.getJSONObject(it) }.associateBy { it.getString("event") }
                val actual = rig.runtime.activeRinging().map {
                    val key = keyOf(it.occurrenceId.substringBefore('@'))
                    val row = named[key]
                    val choices = buildString {
                        if (row?.has("laterMinutes") == true) append("|later=").append(it.laterMinutes)
                        if (row?.has("cantNow") == true) append("|cantNow=").append(it.cantNow)
                    }
                    "$key|${it.occurrenceAt}|${it.title}|${it.snoozesLeft}|${it.snoozeLabel}|${it.snoozeNotice != null}$choices"
                }.sorted()
                val expected = named.values.map { r ->
                    val choices = buildString {
                        if (r.has("laterMinutes")) append("|later=").append(if (r.isNull("laterMinutes")) null else r.getJSONArray("laterMinutes").let { a -> (0 until a.length()).map(a::getInt) })
                        if (r.has("cantNow")) append("|cantNow=").append(if (r.isNull("cantNow")) null else r.getString("cantNow"))
                    }
                    "${r.getString("event")}|${r.getString("at")}|${r.getString("title")}|${r.getInt("snoozesLeft")}|${if (r.isNull("snoozeLabel")) null else r.getString("snoozeLabel")}|${r.getBoolean("noticeShown")}$choices"
                }.sorted()
                assertEquals(where, expected, actual)
            }
            if (step.has("pending")) {
                val expectedArray = step.getJSONArray("pending")
                // doneAt is compared only for a row that names it.
                val named = (0 until expectedArray.length()).map { expectedArray.getJSONObject(it) }
                val withDoneAt = named.any { it.has("doneAt") }
                val actual = rig.runtime.peekCompletions()
                    .map { "${keyOf(it.eventId)}|${it.occurrenceAt}|${it.snoozesUsed}${if (withDoneAt) "|${it.doneAt}" else ""}" }.sorted()
                val expected = named.map { p ->
                    "${p.getString("event")}|${p.getString("at")}|${p.getInt("snoozesUsed")}${if (withDoneAt) "|${p.optString("doneAt")}" else ""}"
                }.sorted()
                assertEquals(where, expected, actual)
            }
        }
    }

    private fun push(rig: Rig, list: JSONObject, settings: JSONObject) {
        val occurrences = list.getJSONArray("occurrences")
        val built = (0 until occurrences.length()).map { index ->
            val o = occurrences.getJSONObject(index)
            val eventId = idOf(o.getString("event"))
            val at = o.getString("at")
            JSONObject().put("id", "$eventId@$at").put("eventId", eventId).put("at", at)
                .put("silenced", o.optBoolean("silenced", false)).put("completed", o.optBoolean("completed", false))
                .also { json ->
                    if (o.has("originalAt")) json.put("originalAt", o.getString("originalAt"))
                    if (o.has("label")) json.put("label", o.getString("label"))
                    if (o.has("windowEnd")) json.put("windowEnd", o.getString("windowEnd"))
                    o.optJSONObject("labelIfUnlogged")?.let { u ->
                        val (key, instant) = u.getString("id").split('@')
                        json.put("labelIfUnlogged", JSONObject().put("id", "${idOf(key)}@$instant").put("label", u.getString("label")))
                    }
                }
        }
        val info = list.getJSONObject("info")
        val eventInfo = JSONObject()
        for (key in info.keys()) {
            val i = info.getJSONObject(key)
            eventInfo.put(idOf(key), Fixtures.info(i.getString("title"), i.getInt("maxSnoozes"), i.getInt("snoozeMinutes")))
        }
        val payload = JSONObject()
            .put("version", 2)
            .put("generatedAt", Instants.format(rig.now))
            .put("horizonEnd", Instants.format(rig.now + 60 * Instants.MS_PER_DAY))
            .put("truncated", false)
            .put("settings", Fixtures.settings(settings.getInt("grace_minutes"), settings.getInt("refire_seconds")))
            .put("occurrences", JSONArray(built.sortedBy { Instants.parse(it.getString("at")) }))
            .put("eventInfo", eventInfo)
        val result = rig.runtime.setSchedule(payload)
        check(result is EngineRuntime.SetScheduleResult.Accepted) { "payload rejected: $result" }
    }
}
