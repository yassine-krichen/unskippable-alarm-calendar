package com.yassine.alarmcalendar.engine

import com.yassine.alarmcalendar.engine.Fixtures.EVENT_A
import com.yassine.alarmcalendar.engine.Fixtures.EVENT_B
import com.yassine.alarmcalendar.engine.Fixtures.at
import com.yassine.alarmcalendar.engine.Fixtures.baseMs
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Behaviour of the engine around the shared vectors: scheduling decisions, persistence, restarts, horizon. */
class EngineRuntimeTest {
    private fun push(rig: Rig, occurrences: List<JSONObject>, info: Map<String, JSONObject> = mapOf(EVENT_A to Fixtures.info()), settings: JSONObject = Fixtures.settings()) {
        val result = rig.runtime.setSchedule(Fixtures.payload(occurrences, info, settings, generatedAtMs = rig.now))
        assertTrue(result.toString(), result is EngineRuntime.SetScheduleResult.Accepted)
    }

    private fun ringingIds(rig: Rig) = rig.runtime.activeRinging().map { it.occurrenceId }

    // --- what to wake up for -------------------------------------------------------------------------------

    @Test
    fun wakesForTheSoonestOccurrenceOnlyAndNothingWhenThereIsNone() {
        val rig = Rig()
        assertNull(rig.runtime.nextTriggerAt())
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 600), Fixtures.occurrence(EVENT_A, 60), Fixtures.occurrence(EVENT_A, 7200)))
        assertEquals(baseMs + 60_000, rig.runtime.nextTriggerAt())
    }

    @Test
    fun aSnoozeWakeUpCompetesWithTheNextOccurrence() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60), Fixtures.occurrence(EVENT_A, 3600)), mapOf(EVENT_A to Fixtures.info(snoozeMinutes = 1)))
        rig.advanceTo(baseMs + 60_000)
        rig.runtime.snooze(ringingIds(rig).single())
        assertEquals(baseMs + 120_000, rig.runtime.nextTriggerAt())
    }

    @Test
    fun afterBootSomethingDueInsideTheGraceWindowIsReportedAsDueNow() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)))
        // The phone was off over the occurrence and comes back 10 minutes later: the next wake-up is in the past, so
        // the host fires at once and the evaluation rings it.
        rig.now = baseMs + 11 * 60_000
        rig.restart()
        val due = rig.runtime.nextTriggerAt()!!
        assertTrue(due <= rig.now)
        assertEquals(1, rig.runtime.evaluate().size)
        assertNull(rig.runtime.nextTriggerAt())
    }

    @Test
    fun afterBootAnOccurrenceOlderThanTheGraceWindowIsNotDueAndNeverRings() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)))
        rig.now = baseMs + 31 * 60_000 + 60_000
        rig.restart()
        assertNull(rig.runtime.nextTriggerAt())
        assertTrue(rig.runtime.evaluate().isEmpty())
    }

    @Test
    fun aClockJumpForwardRingsOnlyTheLatestInsideTheWindowAndLeavesNothingToSpinOn() {
        val rig = Rig()
        push(rig, (1..10).map { Fixtures.occurrence(EVENT_A, it * 600L) })
        rig.now = baseMs + 3_700_000
        assertEquals(1, rig.runtime.evaluate().size)
        // Every earlier occurrence is behind the watermark now, so the next wake-up is a future one.
        val next = rig.runtime.nextTriggerAt()!!
        assertTrue(next > rig.now)
    }

    // --- restarts and persistence --------------------------------------------------------------------------

    @Test
    fun stateSurvivesTheProcessDyingAndAnAlarmThatWasOnScreenRingsAgainAtOnce() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)))
        rig.advanceTo(baseMs + 60_000)
        assertEquals(1, ringingIds(rig).size)

        rig.now += 5_000
        rig.restart()
        // On screen when the process died: no screen now, so it is waiting to ring again immediately.
        assertTrue(rig.runtime.activeRinging().isEmpty())
        assertTrue(rig.runtime.nextTriggerAt()!! <= rig.now)
        assertEquals(1, rig.runtime.evaluate().size)
    }

    @Test
    fun aSnoozeKeepsItsCountAcrossARestart() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)), mapOf(EVENT_A to Fixtures.info(maxSnoozes = 2, snoozeMinutes = 1)))
        rig.advanceTo(baseMs + 60_000)
        rig.runtime.snooze(ringingIds(rig).single())
        rig.restart()
        rig.advanceTo(baseMs + 130_000)
        val view = rig.runtime.activeRinging().single()
        assertEquals(1, view.snoozesUsed)
        assertEquals(1, view.snoozesLeft)
    }

    @Test
    fun doneIsRememberedAcrossARestartAndAStalePushCannotRingItAgain() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)))
        rig.advanceTo(baseMs + 60_000)
        rig.runtime.done(ringingIds(rig).single())
        rig.now += 1000
        rig.restart()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)))
        assertTrue(rig.runtime.activeRinging().isEmpty())
        assertEquals(listOf("$EVENT_A@${at(60)}"), rig.runtime.pendingDoneOccurrenceIds())
    }

    @Test
    fun aCorruptStateFileIsSetAsideAndTheScheduleStillWorks() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)))
        rig.storage.state = "{ this is not json"
        rig.restart()
        assertEquals(listOf("state"), rig.storage.quarantined)
        assertEquals(baseMs + 60_000, rig.runtime.nextTriggerAt())
    }

    @Test
    fun aCorruptScheduleFileIsSetAsideAndTheStateIsKept() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)))
        rig.advanceTo(baseMs + 60_000)
        rig.runtime.done(ringingIds(rig).single())
        rig.storage.schedule = "not json at all"
        rig.restart()
        assertEquals(listOf("schedule"), rig.storage.quarantined)
        assertNull(rig.runtime.nextTriggerAt())
        assertEquals(1, rig.runtime.pendingDoneOccurrenceIds().size)
    }

    @Test
    fun aRejectedPushLeavesThePreviousScheduleInPlace() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)))
        val result = rig.runtime.setSchedule(JSONObject().put("version", 3))
        assertTrue(result is EngineRuntime.SetScheduleResult.Rejected)
        assertEquals(baseMs + 60_000, rig.runtime.nextTriggerAt())
    }

    // --- completions ---------------------------------------------------------------------------------------

    @Test
    fun peekKeepsACompletionUntilItIsAcknowledgedAndAckForgetsItKeepingItKnown() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)), mapOf(EVENT_A to Fixtures.info(maxSnoozes = 3, snoozeMinutes = 1)))
        rig.advanceTo(baseMs + 60_000)
        rig.runtime.snooze(ringingIds(rig).single())
        rig.advanceBy(60)
        rig.runtime.snooze(ringingIds(rig).single())
        rig.advanceBy(60)
        rig.runtime.done(ringingIds(rig).single())

        val first = rig.runtime.peekCompletions()
        assertEquals(1, first.size)
        assertEquals(EVENT_A, first[0].eventId)
        assertEquals(at(60), first[0].occurrenceAt)
        assertEquals("done", first[0].status)
        assertEquals(2, first[0].snoozesUsed)
        assertEquals(Fixtures.USER, first[0].userId)
        assertEquals(Instants.format(rig.now), first[0].doneAt)
        // Peeking removes nothing, also across a restart: a failed or interrupted upsert loses no completion.
        assertEquals(first, rig.runtime.peekCompletions())
        rig.restart()
        assertEquals(first, rig.runtime.peekCompletions())
        assertEquals(1, rig.runtime.pendingDoneOccurrenceIds().size)

        // Unknown ids change nothing; the row id of the completion forgets it.
        assertEquals(0, rig.runtime.ackCompletions(listOf("00000000-0000-4000-8000-00000000dead")))
        assertEquals(1, rig.runtime.ackCompletions(listOf(first[0].id)))
        assertTrue(rig.runtime.peekCompletions().isEmpty())
        assertTrue(rig.runtime.pendingDoneOccurrenceIds().isEmpty())
        rig.restart()
        assertTrue(rig.runtime.peekCompletions().isEmpty())

        // Acknowledged, but still known: a push that does not flag it must not make it ring again.
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)))
        assertTrue(rig.runtime.activeRinging().isEmpty())
    }

    @Test
    fun doneOnAnAlarmThatIsNotRingingChangesNothing() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)))
        assertFalse(rig.runtime.done("$EVENT_A@${at(60)}"))
        assertFalse(rig.runtime.done("garbage"))
        assertTrue(rig.runtime.peekCompletions().isEmpty())
    }

    @Test
    fun aCompletionFlaggedByAPushSurvivesLaterPushesThatDropTheFlag() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60) { it.put("completed", true) }))
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)))
        rig.advanceTo(baseMs + 120_000)
        assertTrue(rig.runtime.activeRinging().isEmpty())
    }

    @Test
    fun anOccurrenceThatIsASecondLateStillRingsWithNoGraceWindowButAMinuteAndABitLateDoesNot() {
        val onTime = Rig()
        push(onTime, listOf(Fixtures.occurrence(EVENT_A, -1)), settings = Fixtures.settings(graceMinutes = 0))
        assertEquals(1, onTime.runtime.activeRinging().size)

        val late = Rig()
        push(late, listOf(Fixtures.occurrence(EVENT_A, -61)), settings = Fixtures.settings(graceMinutes = 0))
        assertTrue(late.runtime.activeRinging().isEmpty())
        assertNull(late.runtime.nextTriggerAt())
    }

    @Test
    fun aSnoozedAlarmWithoutAWakeUpTimeIsTreatedAsRingingAndDueNow() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)))
        rig.advanceTo(baseMs + 60_000)
        rig.runtime.snooze(ringingIds(rig).single())
        // A damaged file: the snooze lost its wake-up time.
        rig.storage.state = rig.storage.state!!.replace(Regex("\"wakeAt\":\"[^\"]*\""), "\"wakeAt\":null")
        rig.now += 1000
        rig.restart()
        assertEquals(1, rig.runtime.evaluate().size)
    }

    @Test
    fun anEventWhoseInfoIsUnusableButWhoseKeyIsAnEventIdKeepsItsRingingAlarm() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)))
        rig.advanceTo(baseMs + 60_000)
        val broken = Fixtures.payload(emptyList(), emptyMap(), generatedAtMs = rig.now)
        broken.getJSONObject("eventInfo").put(EVENT_A, "not an object")
        val result = rig.runtime.setSchedule(broken) as EngineRuntime.SetScheduleResult.Accepted
        assertTrue(result.dismissedOccurrenceIds.isEmpty())
        assertEquals(1, rig.runtime.activeRinging().size)

        // A key that says nothing (not an event id) is not a reason to keep anything.
        val gone = Fixtures.payload(emptyList(), emptyMap(), generatedAtMs = rig.now)
        val dismissed = rig.runtime.setSchedule(gone) as EngineRuntime.SetScheduleResult.Accepted
        assertEquals(1, dismissed.dismissedOccurrenceIds.size)
        assertTrue(rig.runtime.activeRinging().isEmpty())
    }

    // --- dismissal and the screen --------------------------------------------------------------------------

    @Test
    fun windowClosedUsesTheRefireSecondsOfTheSettings() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)), settings = Fixtures.settings(refireSeconds = 20))
        rig.advanceTo(baseMs + 60_000)
        assertTrue(rig.runtime.windowClosed(ringingIds(rig).single()))
        assertEquals(baseMs + 80_000, rig.runtime.nextTriggerAt())
        // A second report for the same dismissal (the alarm is waiting) does not push the re-ring back.
        assertFalse(rig.runtime.windowClosed("$EVENT_A@${at(60)}"))
        assertEquals(baseMs + 80_000, rig.runtime.nextTriggerAt())
    }

    @Test
    fun anEventDeletedWhileRingingIsDismissedAndReportedToTheHost() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60), Fixtures.occurrence(EVENT_B, 60)), mapOf(EVENT_A to Fixtures.info("A"), EVENT_B to Fixtures.info("B")))
        rig.advanceTo(baseMs + 60_000)
        assertEquals(2, rig.runtime.activeRinging().size)
        val result = rig.runtime.setSchedule(Fixtures.payload(listOf(Fixtures.occurrence(EVENT_B, 60)), mapOf(EVENT_B to Fixtures.info("B")), generatedAtMs = rig.now))
            as EngineRuntime.SetScheduleResult.Accepted
        assertEquals(listOf("$EVENT_A@${at(60)}"), result.dismissedOccurrenceIds)
        assertEquals(listOf("$EVENT_B@${at(60)}"), ringingIds(rig))
    }

    @Test
    fun severalRingingAlarmsAreShownOldestFirst() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_B, 30), Fixtures.occurrence(EVENT_A, 60)), mapOf(EVENT_A to Fixtures.info("A"), EVENT_B to Fixtures.info("B")))
        rig.advanceTo(baseMs + 90_000)
        assertEquals(listOf("$EVENT_B@${at(30)}", "$EVENT_A@${at(60)}"), ringingIds(rig))
    }

    @Test
    fun anEditedTitleAndSnoozeRulesReachAnAlarmThatIsAlreadyRinging() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)), mapOf(EVENT_A to Fixtures.info("Old title", maxSnoozes = 1)))
        rig.advanceTo(baseMs + 60_000)
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)), mapOf(EVENT_A to Fixtures.info("New title", maxSnoozes = 3)))
        val view = rig.runtime.activeRinging().single()
        assertEquals("New title", view.title)
        assertEquals(3, view.snoozesLeft)
    }

    // --- button text ---------------------------------------------------------------------------------------

    @Test
    fun snoozeLabelAndNoticeFollowTheSpec() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)), mapOf(EVENT_A to Fixtures.info(maxSnoozes = 2, snoozeMinutes = 5)))
        rig.advanceTo(baseMs + 60_000)
        var view = rig.runtime.activeRinging().single()
        assertEquals("Snooze 5 min · 2 left", view.snoozeLabel)
        assertNull(view.snoozeNotice)
        rig.runtime.snooze(view.occurrenceId)
        rig.advanceBy(5 * 60)
        view = rig.runtime.activeRinging().single()
        assertEquals("Snooze 5 min · 1 left", view.snoozeLabel)
        rig.runtime.snooze(view.occurrenceId)
        rig.advanceBy(5 * 60)
        view = rig.runtime.activeRinging().single()
        assertNull(view.snoozeLabel)
        assertEquals("No snoozes left, do it now", view.snoozeNotice)
    }

    @Test
    fun aPrayerAlarmKeepsItsKindForTheScreen() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)), mapOf(EVENT_A to Fixtures.info("Fajr").put("kind", "prayer").put("prayer", "fajr")))
        rig.advanceTo(baseMs + 60_000)
        assertEquals("prayer", rig.runtime.activeRinging().single().kind)
    }

    // --- horizon ---------------------------------------------------------------------------------------------

    @Test
    fun theHorizonNoticeComesOncePerDayOnlyWhenUnderSevenDaysRemain() {
        val rig = Rig()
        rig.runtime.setSchedule(Fixtures.payload(emptyList(), mapOf(EVENT_A to Fixtures.info()), generatedAtMs = rig.now, horizonDays = 60))
        assertFalse(rig.runtime.takeHorizonNotice())
        assertEquals(baseMs + 53 * Instants.MS_PER_DAY, rig.runtime.nextHorizonCheckAt())

        rig.now = baseMs + 54 * Instants.MS_PER_DAY
        assertTrue(rig.runtime.takeHorizonNotice())
        assertFalse(rig.runtime.takeHorizonNotice())
        // Checked again a day later, and the check is never scheduled in the past.
        assertEquals(rig.now + Instants.MS_PER_DAY, rig.runtime.nextHorizonCheckAt())

        rig.now += Instants.MS_PER_DAY
        assertTrue(rig.runtime.takeHorizonNotice())
    }

    @Test
    fun noScheduleMeansNoNoticeAndNoCheck() {
        val rig = Rig()
        assertFalse(rig.runtime.takeHorizonNotice())
        assertNull(rig.runtime.nextHorizonCheckAt())
    }

    @Test
    fun anExpiredScheduleStillGetsItsNotice() {
        val rig = Rig()
        rig.runtime.setSchedule(Fixtures.payload(emptyList(), mapOf(EVENT_A to Fixtures.info()), generatedAtMs = rig.now, horizonDays = 60))
        rig.now = baseMs + 90 * Instants.MS_PER_DAY
        assertTrue(rig.runtime.takeHorizonNotice())
        assertNotNull(rig.runtime.horizonEndMs())
    }

    // --- reset ---------------------------------------------------------------------------------------------

    @Test
    fun clearForgetsEverything() {
        val rig = Rig()
        push(rig, listOf(Fixtures.occurrence(EVENT_A, 60)))
        rig.advanceTo(baseMs + 60_000)
        rig.runtime.clear()
        assertTrue(rig.runtime.activeRinging().isEmpty())
        assertNull(rig.runtime.nextTriggerAt())
        rig.restart()
        assertNull(rig.runtime.nextTriggerAt())
    }
}
