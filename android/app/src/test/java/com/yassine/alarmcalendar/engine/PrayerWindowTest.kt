package com.yassine.alarmcalendar.engine

import com.yassine.alarmcalendar.engine.Fixtures.EVENT_A
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The prayer window pieces the shared vectors do not reach: the parser, the state file and the engine's refusals. */
class PrayerWindowTest {
    private val minute = Instants.MS_PER_MINUTE

    private fun windowed(windowEnd: Any?, atSeconds: Long = 60): JSONObject =
        Fixtures.occurrence(EVENT_A, atSeconds) { json -> if (windowEnd != null) json.put("windowEnd", windowEnd) }

    private fun parse(occurrence: JSONObject): ScheduleOccurrence =
        Fixtures.accepted(Fixtures.payload(listOf(occurrence), mapOf(EVENT_A to Fixtures.info()))).schedule.occurrences.single()

    // --- PayloadParser ---------------------------------------------------------------------------------------

    @Test
    fun keepsAUsableWindowEnd() {
        val end = Fixtures.at(60 + 3 * 3600)
        assertEquals(Instants.parse(end), parse(windowed(end)).windowEndMs)
    }

    @Test
    fun readsAnUnusableWindowEndAsAbsentInsteadOfDroppingThePrayer() {
        val at = Fixtures.at(60)
        val tooFar = Fixtures.at(60 + 24 * 3600 + 1)
        val exactlyADay = Fixtures.at(60 + 24 * 3600)
        for (bad in listOf<Any>("not a time", 42, at, Fixtures.at(0), tooFar)) {
            assertNull(bad.toString(), parse(windowed(bad)).windowEndMs)
        }
        assertEquals(Instants.parse(exactlyADay), parse(windowed(exactlyADay)).windowEndMs)
        assertNull(parse(windowed(null)).windowEndMs)
    }

    @Test
    fun writesTheWindowEndBackSoAStoredScheduleReadsTheSame() {
        val end = Fixtures.at(60 + 1800)
        val schedule = Fixtures.accepted(Fixtures.payload(listOf(windowed(end)), mapOf(EVENT_A to Fixtures.info()))).schedule
        val again = Fixtures.accepted(PayloadParser.toJson(schedule)).schedule
        assertEquals(Instants.parse(end), again.occurrences.single().windowEndMs)
    }

    // --- the state file --------------------------------------------------------------------------------------

    @Test
    fun theStateFileKeepsTheWindowAndTheLastCall() {
        val state = EngineState()
        state.occurrences.add(
            OccurrenceState(
                EVENT_A, Fixtures.at(60), 0, Phase.SNOOZED, Fixtures.baseMs + 3_000_000, Fixtures.USER, "Dhuhr", null, 0, 5, null, "prayer", false,
                windowEndMs = Fixtures.baseMs + 3_600_000, lastCall = true,
            )
        )
        val read = StateCodec.fromJson(StateCodec.toJson(state)).occurrences.single()
        assertEquals(Fixtures.baseMs + 3_600_000, read.windowEndMs)
        assertTrue(read.lastCall)
    }

    @Test
    fun anOlderStateFileWithoutTheFieldsLoadsAsAPlainAlarm() {
        val state = EngineState()
        state.occurrences.add(OccurrenceState(EVENT_A, Fixtures.at(60), 1, Phase.RINGING, null, Fixtures.USER, "Take medication", null, 2, 5, null, null, false))
        val json = StateCodec.toJson(state)
        val occurrence = json.getJSONArray("occurrences").getJSONObject(0)
        occurrence.remove("windowEnd")
        occurrence.remove("lastCall")
        val read = StateCodec.fromJson(json).occurrences.single()
        assertNull(read.windowEndMs)
        assertFalse(read.lastCall)
        assertEquals(1, read.snoozesUsed)
    }

    // --- the engine --------------------------------------------------------------------------------------------

    private fun prayerRig(windowEndSeconds: Long, startSeconds: Long = 0): Rig {
        val rig = Rig(startMs = Fixtures.baseMs + startSeconds * 1000)
        val info = Fixtures.info("Dhuhr", maxSnoozes = 3).put("kind", "prayer").put("prayer", "dhuhr")
        val payload = Fixtures.payload(
            listOf(windowed(Fixtures.at(windowEndSeconds), atSeconds = 60)),
            mapOf(EVENT_A to info),
            generatedAtMs = rig.now,
        )
        check(rig.runtime.setSchedule(payload) is EngineRuntime.SetScheduleResult.Accepted)
        return rig
    }

    @Test
    fun laterRefusesWhatIsNotAPresetOrNoLongerFits() {
        val rig = prayerRig(windowEndSeconds = 60 + 3 * 3600)
        rig.advanceTo(Fixtures.baseMs + 60_000)
        val id = rig.runtime.activeRinging().single().occurrenceId
        for (minutes in listOf(0, 5, 19, 61, -20)) assertFalse("$minutes", rig.runtime.later(id, minutes))
        assertEquals(1, rig.runtime.activeRinging().size)
        // 25 minutes before the end nothing fits.
        rig.advanceTo(Fixtures.baseMs + 60_000 + (3 * 60 - 25) * minute)
        for (minutes in listOf(20, 40, 60)) assertFalse("$minutes", rig.runtime.later(id, minutes))
        assertTrue(rig.runtime.activeRinging().single().laterMinutes!!.isEmpty())
    }

    @Test
    fun aPrayerWithAWindowRefusesSnoozeAndIsDismissedAtTheEnd() {
        val rig = prayerRig(windowEndSeconds = 60 + 1800)
        rig.advanceTo(Fixtures.baseMs + 60_000)
        val id = rig.runtime.activeRinging().single().occurrenceId
        assertFalse(rig.runtime.snooze(id))
        rig.advanceTo(Fixtures.baseMs + 60_000 + 1800_000 - 1000)
        assertEquals(1, rig.runtime.activeRinging().size)
        rig.advanceTo(Fixtures.baseMs + 60_000 + 1800_000)
        assertTrue(rig.runtime.activeRinging().isEmpty())
        assertTrue(rig.runtime.peekCompletions().isEmpty())
        // Never rings again, even much later.
        rig.advanceTo(Fixtures.baseMs + 6 * 3600_000)
        assertTrue(rig.runtime.activeRinging().isEmpty())
    }

    @Test
    fun theWindowEndIsAWakeUpOfItsOwnSoTheHostCanCloseTheScreen() {
        val rig = prayerRig(windowEndSeconds = 60 + 1800)
        rig.advanceTo(Fixtures.baseMs + 60_000)
        val id = rig.runtime.activeRinging().single().occurrenceId
        // The user leaves the alarm on screen; the only thing left to wake for is the window end.
        assertEquals(Fixtures.baseMs + 60_000 + 1800_000, rig.runtime.nextTriggerAt())
        assertTrue(rig.runtime.cantNow(id, EngineCore.CANT_NOW_UNTIL_LAST_CALL))
        // Quiet until the last call (15 minutes in, half the window), which comes before the end.
        assertEquals(Fixtures.baseMs + 60_000 + 900_000, rig.runtime.nextTriggerAt())
    }

    @Test
    fun aCantNowOnAStaleButtonIsRefusedAndTheEarlyGiveUpToo() {
        val rig = prayerRig(windowEndSeconds = 60 + 3 * 3600)
        rig.advanceTo(Fixtures.baseMs + 60_000)
        val id = rig.runtime.activeRinging().single().occurrenceId
        // A give-up press while the view still says until_last_call is refused.
        assertFalse(rig.runtime.cantNow(id, EngineCore.CANT_NOW_GIVE_UP))
        // The person saw "last call"; by the time it is pressed it is the last call: refused, the prayer keeps ringing.
        rig.advanceTo(Fixtures.baseMs + 60_000 + (3 * 60 - 20) * minute - 30_000)
        assertFalse(rig.runtime.cantNow(id, EngineCore.CANT_NOW_UNTIL_LAST_CALL))
        assertEquals(EngineCore.CANT_NOW_GIVE_UP, rig.runtime.activeRinging().single().cantNow)
        assertTrue(rig.runtime.cantNow(id, EngineCore.CANT_NOW_GIVE_UP))
        assertTrue(rig.runtime.activeRinging().isEmpty())
    }

    @Test
    fun theScreenRedrawsWhereTheChoicesChangeByThemselves() {
        val rig = prayerRig(windowEndSeconds = 60 + 3 * 3600)
        rig.advanceTo(Fixtures.baseMs + 60_000 + 80 * minute)
        val view = rig.runtime.activeRinging().single()
        // 100 minutes left: +60 stops fitting with 70 left, 30 minutes on; the give-up button is 79 minutes away.
        assertEquals(rig.now + 30 * minute + 1, EngineCore.nextChoiceChangeAt(view, rig.now))
        rig.advanceTo(Fixtures.baseMs + 60_000 + (3 * 60 - 25) * minute)
        val late = rig.runtime.activeRinging().single()
        assertEquals(rig.now + 4 * minute, EngineCore.nextChoiceChangeAt(late, rig.now))
        rig.advanceTo(Fixtures.baseMs + 60_000 + (3 * 60 - 15) * minute)
        assertNull(EngineCore.nextChoiceChangeAt(rig.runtime.activeRinging().single(), rig.now))
    }

    @Test
    fun aRestartPastTheWindowDismissesTheRingingStateInsteadOfRingingIt() {
        val rig = prayerRig(windowEndSeconds = 60 + 1800)
        rig.advanceTo(Fixtures.baseMs + 60_000)
        assertEquals(1, rig.runtime.activeRinging().size)
        rig.now = Fixtures.baseMs + 60_000 + 1900_000
        rig.restart()
        assertTrue(rig.runtime.evaluate().isEmpty())
    }

    // --- the arithmetic mirrored from core ----------------------------------------------------------------------

    @Test
    fun theLastCallAndTheLaterChoicesFollowTheCoreRules() {
        val at = 0L
        assertEquals(160 * minute, EngineCore.finalCallAt(at, 180 * minute))
        assertEquals(20 * minute, EngineCore.finalCallAt(at, 40 * minute))
        assertEquals(15 * minute, EngineCore.finalCallAt(at, 30 * minute))
        val end = 180 * minute
        assertEquals(listOf(20, 40, 60), EngineCore.laterChoices(end, end - 70 * minute))
        assertEquals(listOf(20, 40), EngineCore.laterChoices(end, end - 69 * minute))
        assertEquals(listOf(20), EngineCore.laterChoices(end, end - 30 * minute))
        assertEquals(emptyList<Int>(), EngineCore.laterChoices(end, end - 29 * minute))
        assertEquals(EngineCore.CANT_NOW_UNTIL_LAST_CALL, EngineCore.cantNowChoice(at, end, end - 22 * minute, false))
        assertEquals(EngineCore.CANT_NOW_GIVE_UP, EngineCore.cantNowChoice(at, end, end - 21 * minute, false))
        assertEquals(EngineCore.CANT_NOW_GIVE_UP, EngineCore.cantNowChoice(at, end, end - 100 * minute, true))
    }
}
