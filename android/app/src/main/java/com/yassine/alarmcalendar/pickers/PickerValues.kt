package com.yassine.alarmcalendar.pickers

import java.util.Locale

/**
 * The wall-clock strings the web side and the platform pickers exchange, as pure functions (no Android classes, so
 * the JVM tests cover them). Times are 'HH:mm' (24-hour) and dates 'yyyy-MM-dd', exactly what the form stores. No
 * time zone is involved here or anywhere in the picker path: the app works in the settings zone's wall clock, so
 * nothing is converted to an instant on this side.
 */
object PickerValues {
    private val TIME_PATTERN = Regex("^(\\d{2}):(\\d{2})$")
    private val DATE_PATTERN = Regex("^(\\d{4})-(\\d{2})-(\\d{2})$")

    data class Time(val hour: Int, val minute: Int)

    /** Month is 1..12, as in the string (the platform dialogs count from 0; the plugin converts). */
    data class Date(val year: Int, val month: Int, val day: Int)

    /** 'HH:mm' to its parts, or null when it is not a real time of day. */
    fun parseTime(value: String?): Time? {
        val match = value?.let { TIME_PATTERN.matchEntire(it) } ?: return null
        val hour = match.groupValues[1].toInt()
        val minute = match.groupValues[2].toInt()
        return if (hour in 0..23 && minute in 0..59) Time(hour, minute) else null
    }

    fun formatTime(hour: Int, minute: Int): String = String.format(Locale.ROOT, "%02d:%02d", hour, minute)

    /** 'yyyy-MM-dd' to its parts, or null when it is not a real calendar day (no 2026-02-30). */
    fun parseDate(value: String?): Date? {
        val match = value?.let { DATE_PATTERN.matchEntire(it) } ?: return null
        val year = match.groupValues[1].toInt()
        val month = match.groupValues[2].toInt()
        val day = match.groupValues[3].toInt()
        if (month !in 1..12) return null
        return if (day in 1..daysInMonth(year, month)) Date(year, month, day) else null
    }

    /** [month] is 1..12 here, as in the string; the platform dialogs count from 0, so the plugin converts. */
    fun formatDate(year: Int, month: Int, day: Int): String = String.format(Locale.ROOT, "%04d-%02d-%02d", year, month, day)

    fun daysInMonth(year: Int, month: Int): Int = when (month) {
        2 -> if (isLeapYear(year)) 29 else 28
        4, 6, 9, 11 -> 30
        else -> 31
    }

    private fun isLeapYear(year: Int): Boolean = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}
