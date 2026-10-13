package com.yassine.alarmcalendar.engine

/**
 * ISO 8601 instants and occurrence ids without java.time (minSdk 24 has no desugaring here) and without
 * SimpleDateFormat (not thread safe). Occurrence ids are `<event uuid>@<ISO UTC with milliseconds>`, the same
 * format as core's makeOccurrenceId, and are parsed as strictly as electron's parseOccurrenceId.
 */
object Instants {
    private val ISO = Regex("""^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$""")
    private val CANONICAL = Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$""")
    private val UUID = Regex("""^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$""")

    const val MS_PER_MINUTE = 60_000L
    const val MS_PER_DAY = 24 * 60 * MS_PER_MINUTE

    fun isUuid(text: String): Boolean = UUID.matches(text)

    /** Epoch milliseconds of an ISO 8601 timestamp (Z or an offset), or null when it is not one. */
    fun parse(text: String): Long? {
        if (text.length > 40) return null
        val m = ISO.matchEntire(text) ?: return null
        val g = m.groupValues
        val year = g[1].toInt()
        val month = g[2].toInt()
        val day = g[3].toInt()
        val hour = g[4].toInt()
        val minute = g[5].toInt()
        val second = g[6].toInt()
        if (year < 1970 || month !in 1..12 || day !in 1..daysInMonth(year, month)) return null
        if (hour > 23 || minute > 59 || second > 59) return null
        val millis = if (g[7].isEmpty()) 0 else g[7].padEnd(3, '0').take(3).toInt()
        var offsetMs = 0L
        if (g[8] != "Z") {
            val sign = if (g[8][0] == '-') -1 else 1
            val offHour = g[8].substring(1, 3).toInt()
            val offMinute = g[8].substring(4, 6).toInt()
            if (offHour > 23 || offMinute > 59) return null
            offsetMs = sign * (offHour * 60L + offMinute) * MS_PER_MINUTE
        }
        val days = daysFromCivil(year, month, day)
        return days * MS_PER_DAY + ((hour * 60L + minute) * 60 + second) * 1000 + millis - offsetMs
    }

    /** `yyyy-MM-ddTHH:mm:ss.SSSZ`, what JSON.stringify(new Date()) gives. */
    fun format(epochMs: Long): String {
        val days = Math.floorDiv(epochMs, MS_PER_DAY)
        val msOfDay = Math.floorMod(epochMs, MS_PER_DAY)
        val (y, mo, d) = civilFromDays(days)
        val h = msOfDay / 3_600_000
        val mi = msOfDay / 60_000 % 60
        val s = msOfDay / 1000 % 60
        val ms = msOfDay % 1000
        return "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ".format(y, mo, d, h, mi, s, ms)
    }

    fun makeOccurrenceId(eventId: String, atMs: Long): String = "$eventId@${format(atMs)}"

    class ParsedId(val eventId: String, val occurrenceAt: String, val atMs: Long)

    /** Null for anything that is not exactly `<uuid>@<canonical ISO UTC instant>`. */
    fun parseOccurrenceId(value: String): ParsedId? {
        if (value.length > 100) return null
        val separator = value.indexOf('@')
        if (separator < 0) return null
        val eventId = value.substring(0, separator)
        val at = value.substring(separator + 1)
        if (!isUuid(eventId) || !CANONICAL.matches(at)) return null
        val ms = parse(at) ?: return null
        // Round trip rejects impossible dates such as 2026-02-31.
        if (format(ms) != at) return null
        return ParsedId(eventId, at, ms)
    }

    private fun isLeap(year: Int) = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0

    private fun daysInMonth(year: Int, month: Int): Int = when (month) {
        2 -> if (isLeap(year)) 29 else 28
        4, 6, 9, 11 -> 30
        else -> 31
    }

    // Howard Hinnant's civil-date algorithms (days since 1970-01-01).
    private fun daysFromCivil(year: Int, month: Int, day: Int): Long {
        val y = (if (month <= 2) year - 1 else year).toLong()
        val era = Math.floorDiv(y, 400L)
        val yoe = y - era * 400
        val mp = (month + 9) % 12
        val doy = (153 * mp + 2) / 5 + day - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146097 + doe - 719468
    }

    private fun civilFromDays(daysSinceEpoch: Long): Triple<Int, Int, Int> {
        val z = daysSinceEpoch + 719468
        val era = Math.floorDiv(z, 146097L)
        val doe = z - era * 146097
        val yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
        val y = yoe + era * 400
        val doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        val mp = (5 * doy + 2) / 153
        val d = (doy - (153 * mp + 2) / 5 + 1).toInt()
        val m = (if (mp < 10) mp + 3 else mp - 9).toInt()
        return Triple((if (m <= 2) y + 1 else y).toInt(), m, d)
    }
}
