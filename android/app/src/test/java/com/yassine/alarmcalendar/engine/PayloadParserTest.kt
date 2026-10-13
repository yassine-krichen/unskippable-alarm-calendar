package com.yassine.alarmcalendar.engine

import com.yassine.alarmcalendar.engine.Fixtures.EVENT_A
import com.yassine.alarmcalendar.engine.Fixtures.EVENT_B
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PayloadParserTest {
    private fun valid(extra: List<JSONObject> = emptyList()) =
        Fixtures.payload(listOf(Fixtures.occurrence(EVENT_A, 60)) + extra, mapOf(EVENT_A to Fixtures.info(), EVENT_B to Fixtures.info("Other")))

    private fun rejected(payload: JSONObject): String =
        (PayloadParser.parse(payload) as PayloadParser.Result.Rejected).reason

    @Test
    fun acceptsAWellFormedPayloadAndSortsItByInstantThenEvent() {
        val payload = valid(listOf(Fixtures.occurrence(EVENT_B, 60), Fixtures.occurrence(EVENT_A, 30)))
        val schedule = Fixtures.accepted(payload).schedule
        assertEquals(listOf(30L, 60L, 60L).map { Fixtures.baseMs + it * 1000 }, schedule.occurrences.map { it.atMs })
        assertEquals(listOf(EVENT_A, EVENT_A, EVENT_B), schedule.occurrences.map { it.eventId })
        assertEquals(2, schedule.eventInfo.size)
        assertEquals(30, schedule.settings.graceMinutes)
    }

    @Test
    fun rejectsAnUnusableEnvelopeAsAWhole() {
        assertTrue(rejected(valid().put("version", 1)).startsWith("version"))
        assertTrue(rejected(valid().put("generatedAt", "yesterday")).startsWith("generatedAt"))
        assertTrue(rejected(valid().put("horizonEnd", 5)).startsWith("horizonEnd"))
        assertTrue(rejected(valid().put("occurrences", "none")).startsWith("occurrences"))
        assertTrue(rejected(valid().put("eventInfo", JSONArray())).startsWith("eventInfo"))
        assertTrue(rejected(valid().put("settings", JSONObject().put("timezone", "UTC"))).startsWith("settings"))
        assertTrue(rejected(valid().put("settings", Fixtures.settings().put("user_id", "me"))).startsWith("settings"))
    }

    @Test
    fun rejectsMoreThanTheBoundsElectronAlsoEnforces() {
        val tooMany = JSONArray()
        repeat(PayloadParser.MAX_OCCURRENCES + 1) { tooMany.put(JSONObject()) }
        assertTrue(rejected(valid().put("occurrences", tooMany)).startsWith("occurrences"))
    }

    @Test
    fun dropsABadOccurrenceRowWithoutLosingTheRest() {
        val wrongId = Fixtures.occurrence(EVENT_A, 90).put("id", "$EVENT_A@${Fixtures.at(91)}")
        val otherEvent = Fixtures.occurrence(EVENT_A, 120).put("eventId", EVENT_B)
        val noMillis = Fixtures.occurrence(EVENT_A, 150).put("at", "2026-03-02T09:02:30Z")
        val unknownEvent = Fixtures.occurrence("33333333-3333-4333-8333-333333333333", 180)
        val notAnObject = "just a string"
        val payload = valid(listOf(wrongId, otherEvent, noMillis, unknownEvent)).also { it.getJSONArray("occurrences").put(notAnObject) }

        val accepted = Fixtures.accepted(payload)
        assertEquals(1, accepted.schedule.occurrences.size)
        assertEquals(5, accepted.dropped.occurrences)
    }

    @Test
    fun dropsDuplicateIdsKeepingTheFirst() {
        val accepted = Fixtures.accepted(valid(listOf(Fixtures.occurrence(EVENT_A, 60))))
        assertEquals(1, accepted.schedule.occurrences.size)
        assertEquals(1, accepted.dropped.occurrences)
    }

    @Test
    fun aFlagThatIsNotABooleanNeverSilencesOrCompletes() {
        val sneaky = Fixtures.occurrence(EVENT_A, 60) { it.put("silenced", "true").put("completed", 1) }
        val schedule = Fixtures.accepted(Fixtures.payload(listOf(sneaky), mapOf(EVENT_A to Fixtures.info()))).schedule
        assertFalse(schedule.occurrences.single().silenced)
        assertFalse(schedule.occurrences.single().completed)
    }

    @Test
    fun repairsEventInfoTowardsRingingInsteadOfDroppingTheEvent() {
        val broken = JSONObject().put("title", "   ").put("notes", 5).put("maxSnoozes", 99).put("snoozeMinutes", -3)
            .put("soundId", "../etc/passwd").put("kind", "bogus")
        val info = Fixtures.accepted(Fixtures.payload(listOf(Fixtures.occurrence(EVENT_A, 60)), mapOf(EVENT_A to broken))).schedule.eventInfo.getValue(EVENT_A)
        assertEquals("Alarm", info.title)
        assertNull(info.notes)
        assertEquals(10, info.maxSnoozes)
        assertEquals(1, info.snoozeMinutes)
        assertNull(info.soundId)
        assertNull(info.kind)
    }

    @Test
    fun anUnreadableSnoozeCountMeansNoSnoozes() {
        val broken = Fixtures.info().put("maxSnoozes", "lots")
        val info = Fixtures.accepted(Fixtures.payload(listOf(Fixtures.occurrence(EVENT_A, 60)), mapOf(EVENT_A to broken))).schedule.eventInfo.getValue(EVENT_A)
        assertEquals(0, info.maxSnoozes)
    }

    @Test
    fun dropsEventInfoThatIsNotAnObjectOrNotKeyedByAnEventId() {
        val payload = valid()
        payload.getJSONObject("eventInfo").put("not-a-uuid", Fixtures.info()).put("33333333-3333-4333-8333-333333333333", "text")
        val accepted = Fixtures.accepted(payload)
        assertEquals(2, accepted.schedule.eventInfo.size)
        assertEquals(2, accepted.dropped.eventInfo)
    }

    @Test
    fun clampsSettingsToTheLookBackAndRefireBounds() {
        val settings = Fixtures.settings(graceMinutes = 99_999, refireSeconds = 0)
        val schedule = Fixtures.accepted(Fixtures.payload(emptyList(), mapOf(EVENT_A to Fixtures.info()), settings)).schedule
        assertEquals(PayloadParser.MAX_LOOKBACK_MINUTES, schedule.settings.graceMinutes)
        assertEquals(1, schedule.settings.refireSeconds)
    }

    @Test
    fun anInvalidTimeZoneOrSoundOnlyFallsBack() {
        val settings = Fixtures.settings().put("timezone", "").put("sound", "Bell!")
        val schedule = Fixtures.accepted(Fixtures.payload(emptyList(), emptyMap(), settings)).schedule
        assertEquals("UTC", schedule.settings.timezone)
        assertNull(schedule.settings.sound)
    }

    @Test
    fun shiftedOccurrencesKeepOriginalAtOnlyWithinTwelveHoursAndNeverEqualToAt() {
        val ok = Fixtures.occurrence(EVENT_A, 600) { it.put("originalAt", Fixtures.at(0)) }
        val same = Fixtures.occurrence(EVENT_A, 700) { it.put("originalAt", Fixtures.at(700)) }
        val far = Fixtures.occurrence(EVENT_A, 800) { it.put("originalAt", Fixtures.at(800 + 13 * 3600)) }
        val schedule = Fixtures.accepted(Fixtures.payload(listOf(ok, same, far), mapOf(EVENT_A to Fixtures.info()))).schedule
        assertEquals(Fixtures.at(0), schedule.occurrences[0].originalAt)
        assertNull(schedule.occurrences[1].originalAt)
        assertNull(schedule.occurrences[2].originalAt)
    }

    @Test
    fun labelsAreKeptOnlyWhenWellFormed() {
        val previous = "$EVENT_B@${Fixtures.at(0)}"
        val good = Fixtures.occurrence(EVENT_A, 60) {
            it.put("label", "Asr in 15 min").put("labelIfUnlogged", JSONObject().put("id", previous).put("label", "You have not logged Dhuhr"))
        }
        val bad = Fixtures.occurrence(EVENT_A, 120) {
            it.put("label", "").put("labelIfUnlogged", JSONObject().put("id", "nope").put("label", "x"))
        }
        val schedule = Fixtures.accepted(Fixtures.payload(listOf(good, bad), mapOf(EVENT_A to Fixtures.info()))).schedule
        assertEquals("Asr in 15 min", schedule.occurrences[0].label)
        assertEquals(previous, schedule.occurrences[0].labelIfUnlogged?.id)
        assertNull(schedule.occurrences[1].label)
        assertNull(schedule.occurrences[1].labelIfUnlogged)
    }

    @Test
    fun whatIsStoredReadsBackIdentically() {
        val payload = valid(listOf(Fixtures.occurrence(EVENT_B, 90) { it.put("label", "Hello").put("silenced", true) }))
        val first = Fixtures.accepted(payload).schedule
        val second = Fixtures.accepted(PayloadParser.toJson(first)).schedule
        assertEquals(first.occurrences, second.occurrences)
        assertEquals(first.eventInfo, second.eventInfo)
        assertEquals(first.settings, second.settings)
        assertEquals(first.horizonEndMs, second.horizonEndMs)
    }
}
