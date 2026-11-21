package com.yassine.alarmcalendar.pickers

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PickerValuesTest {
    @Test
    fun parsesAndFormatsATimeOfDayBothWays() {
        assertEquals(PickerValues.Time(9, 5), PickerValues.parseTime("09:05"))
        assertEquals(PickerValues.Time(0, 0), PickerValues.parseTime("00:00"))
        assertEquals(PickerValues.Time(23, 59), PickerValues.parseTime("23:59"))
        assertEquals("09:05", PickerValues.formatTime(9, 5))
        assertEquals("00:00", PickerValues.formatTime(0, 0))
    }

    @Test
    fun refusesWhatIsNotATimeOfDay() {
        assertNull(PickerValues.parseTime(null))
        assertNull(PickerValues.parseTime(""))
        assertNull(PickerValues.parseTime("9:05"))
        assertNull(PickerValues.parseTime("24:00"))
        assertNull(PickerValues.parseTime("12:60"))
        assertNull(PickerValues.parseTime("12:30:15"))
        assertNull(PickerValues.parseTime("8:30 pm"))
    }

    @Test
    fun parsesAndFormatsADateBothWays() {
        assertEquals(PickerValues.Date(2026, 11, 21), PickerValues.parseDate("2026-11-21"))
        assertEquals("2026-01-05", PickerValues.formatDate(2026, 1, 5))
        // the round trip is exact, which is what the form relies on
        val back = PickerValues.parseDate("2026-01-05")!!
        assertEquals("2026-01-05", PickerValues.formatDate(back.year, back.month, back.day))
    }

    @Test
    fun knowsLeapYearsWhenCheckingTheDay() {
        assertEquals(PickerValues.Date(2028, 2, 29), PickerValues.parseDate("2028-02-29"))
        assertNull(PickerValues.parseDate("2026-02-29"))
        assertNull(PickerValues.parseDate("2100-02-29"))
        assertEquals(PickerValues.Date(2000, 2, 29), PickerValues.parseDate("2000-02-29"))
    }

    @Test
    fun refusesWhatIsNotACalendarDay() {
        assertNull(PickerValues.parseDate(null))
        assertNull(PickerValues.parseDate(""))
        assertNull(PickerValues.parseDate("2026-13-01"))
        assertNull(PickerValues.parseDate("2026-00-10"))
        assertNull(PickerValues.parseDate("2026-04-31"))
        assertNull(PickerValues.parseDate("2026-4-1"))
        assertNull(PickerValues.parseDate("21/11/2026"))
    }
}
