package com.yassine.alarmcalendar.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class InstantsTest {
    @Test
    fun parsesAndFormatsTheSameInstantsJavaScriptDoes() {
        // Date.parse('2026-03-02T09:01:00.000Z') in Node.
        assertEquals(1772442060000L, Instants.parse("2026-03-02T09:01:00.000Z"))
        assertEquals("2026-03-02T09:01:00.000Z", Instants.format(1772442060000L))
        assertEquals(0L, Instants.parse("1970-01-01T00:00:00Z"))
        assertEquals("1970-01-01T00:00:00.000Z", Instants.format(0))
    }

    @Test
    fun leapDayAndCenturyRulesHold() {
        assertNotNull(Instants.parse("2028-02-29T12:00:00.000Z"))
        assertNull(Instants.parse("2027-02-29T12:00:00.000Z"))
        assertNull(Instants.parse("2100-02-29T12:00:00.000Z"))
        assertNotNull(Instants.parse("2000-02-29T12:00:00.000Z"))
        assertEquals("2028-02-29T23:59:59.999Z", Instants.format(Instants.parse("2028-02-29T23:59:59.999Z")!!))
    }

    @Test
    fun offsetsAreAppliedAndFractionsAreTruncatedToMilliseconds() {
        assertEquals(Instants.parse("2026-03-02T09:00:00.000Z"), Instants.parse("2026-03-02T10:00:00+01:00"))
        assertEquals(Instants.parse("2026-03-02T09:00:00.000Z"), Instants.parse("2026-03-02T09:00:00+00:00"))
        assertEquals(Instants.parse("2026-03-02T09:00:00.123Z"), Instants.parse("2026-03-02T09:00:00.123456Z"))
        assertEquals(Instants.parse("2026-03-02T09:00:00.500Z"), Instants.parse("2026-03-02T09:00:00.5Z"))
    }

    @Test
    fun rejectsWhatIsNotATimestamp() {
        for (bad in listOf("", "tomorrow", "2026-13-01T00:00:00Z", "2026-03-02T24:00:00Z", "2026-03-02T09:00:00", "2026-03-02", "2026-03-02T09:00:00+25:00")) {
            assertNull(bad, Instants.parse(bad))
        }
    }

    @Test
    fun roundTripsAcrossYearBoundariesAndNegativeFloor() {
        var ms = Instants.parse("2026-12-31T23:59:59.999Z")!!
        assertEquals("2026-12-31T23:59:59.999Z", Instants.format(ms))
        ms += 1
        assertEquals("2027-01-01T00:00:00.000Z", Instants.format(ms))
        assertEquals("1969-12-31T23:59:59.999Z", Instants.format(-1))
    }

    @Test
    fun occurrenceIdsAreParsedStrictly() {
        val id = "11111111-1111-4111-8111-111111111111@2026-03-02T09:01:00.000Z"
        val parsed = Instants.parseOccurrenceId(id)
        assertNotNull(parsed)
        assertEquals("11111111-1111-4111-8111-111111111111", parsed!!.eventId)
        assertEquals("2026-03-02T09:01:00.000Z", parsed.occurrenceAt)
        for (bad in listOf(
            "no-at-sign",
            "11111111-1111-4111-8111-111111111111@2026-03-02T09:01:00Z", // no milliseconds
            "11111111-1111-4111-8111-111111111111@2026-02-31T09:01:00.000Z", // impossible date
            "not-a-uuid@2026-03-02T09:01:00.000Z",
            "11111111-1111-4111-8111-111111111111@2026-03-02T09:01:00.000+01:00",
        )) {
            assertNull(bad, Instants.parseOccurrenceId(bad))
        }
    }
}
