package com.yassine.alarmcalendar.engine

import org.json.JSONArray
import org.json.JSONObject

/**
 * Defensive reading of a SchedulePayload (version 2). The bounds are those of electron's zod schemas
 * (desktop-payloads.ts). Differences, all on the side of ringing: electron drops an event whose info is out of
 * range and with it every occurrence of that event, while here the info is repaired (a blank title becomes
 * "Alarm", a snooze count above 10 becomes 10, ...) because this engine has no refill source to recover from and a
 * silent alarm is the worse failure. A flag that is not a boolean reads as false, so it can never silence or
 * complete an occurrence. Only what cannot be repaired is dropped, one row at a time: an occurrence whose id,
 * event or instant is unusable, an event-info entry that is not an object or whose key is not an event id, and
 * occurrences of events without info. Only an unusable envelope or a settings object without a user id rejects the
 * whole push, since without it a completion could not be written.
 */
object PayloadParser {
    const val MAX_OCCURRENCES = 5000
    const val MAX_EVENTS = 5000
    const val MAX_LOOKBACK_MINUTES = 7 * 24 * 60
    const val MAX_SHIFT_MS = 12 * 60 * Instants.MS_PER_MINUTE

    private val SOUND_ID = Regex("^[a-z0-9-]{1,32}$")
    private val KINDS = setOf("normal", "prayer", "pre_prayer")
    private val PRAYERS = setOf("fajr", "dhuhr", "asr", "maghrib", "isha")

    data class Dropped(val occurrences: Int, val eventInfo: Int)

    sealed class Result {
        /**
         * `retainedEventIds`: events whose info was unusable but whose key is an event id. Their ringing and snoozed
         * alarms are kept, not dismissed, because the key shows the event still exists.
         */
        class Accepted(val schedule: Schedule, val dropped: Dropped, val retainedEventIds: Set<String>) : Result()
        class Rejected(val reason: String) : Result()
    }

    fun parse(root: JSONObject): Result {
        if ((root.opt("version") as? Number)?.toInt() != 2) return Result.Rejected("version: must be 2")
        val generatedAt = (root.opt("generatedAt") as? String)?.let(Instants::parse)
            ?: return Result.Rejected("generatedAt: not a timestamp")
        val horizonEnd = (root.opt("horizonEnd") as? String)?.let(Instants::parse)
            ?: return Result.Rejected("horizonEnd: not a timestamp")
        val truncated = root.opt("truncated") as? Boolean ?: false

        val settingsJson = root.opt("settings") as? JSONObject ?: return Result.Rejected("settings: not an object")
        val settings = parseSettings(settingsJson) ?: return Result.Rejected("settings.user_id: not a uuid")

        val occurrencesJson = root.opt("occurrences") as? JSONArray ?: return Result.Rejected("occurrences: not an array")
        if (occurrencesJson.length() > MAX_OCCURRENCES) return Result.Rejected("occurrences: too many")
        val eventInfoJson = root.opt("eventInfo") as? JSONObject ?: return Result.Rejected("eventInfo: not an object")
        if (eventInfoJson.length() > MAX_EVENTS) return Result.Rejected("eventInfo: too many entries")

        val eventInfo = LinkedHashMap<String, EventInfo>()
        val retained = HashSet<String>()
        var droppedInfo = 0
        for (key in eventInfoJson.keys()) {
            val info = (eventInfoJson.opt(key) as? JSONObject)?.takeIf { Instants.isUuid(key) }?.let(::parseEventInfo)
            if (info == null) {
                droppedInfo++
                if (Instants.isUuid(key)) retained.add(key)
            } else {
                eventInfo[key] = info
            }
        }

        val seen = HashSet<String>()
        val occurrences = ArrayList<ScheduleOccurrence>(occurrencesJson.length())
        for (i in 0 until occurrencesJson.length()) {
            val occurrence = (occurrencesJson.opt(i) as? JSONObject)?.let(::parseOccurrence)
            if (occurrence != null && eventInfo.containsKey(occurrence.eventId) && seen.add(occurrence.id)) {
                occurrences.add(occurrence)
            }
        }
        occurrences.sortWith(compareBy<ScheduleOccurrence> { it.atMs }.thenBy { it.eventId })

        return Result.Accepted(
            Schedule(generatedAt, horizonEnd, truncated, settings, occurrences, eventInfo),
            Dropped(occurrencesJson.length() - occurrences.size, droppedInfo),
            retained,
        )
    }

    private fun parseSettings(json: JSONObject): EngineSettings? {
        val userId = (json.opt("user_id") as? String)?.takeIf(Instants::isUuid) ?: return null
        val timezone = (json.opt("timezone") as? String)?.takeIf { it.isNotBlank() && it.length <= 100 } ?: "UTC"
        return EngineSettings(
            userId = userId,
            timezone = timezone,
            graceMinutes = clampedInt(json.opt("grace_minutes"), 0, MAX_LOOKBACK_MINUTES, 30),
            refireSeconds = clampedInt(json.opt("refire_seconds"), 1, 604_800, 120),
            sound = (json.opt("sound") as? String)?.takeIf(SOUND_ID::matches),
            prayerSound = (json.opt("prayerSound") as? String)?.takeIf(SOUND_ID::matches),
        )
    }

    private fun parseEventInfo(json: JSONObject): EventInfo {
        val title = (json.opt("title") as? String)?.takeIf { it.isNotBlank() }?.take(2000) ?: "Alarm"
        // Failing towards "unskippable": an unreadable snooze count means no snoozes.
        return EventInfo(
            title = title,
            notes = (json.opt("notes") as? String)?.take(20_000),
            maxSnoozes = clampedInt(json.opt("maxSnoozes"), 0, 10, 0),
            snoozeMinutes = clampedInt(json.opt("snoozeMinutes"), 1, 100_000, 5),
            soundId = (json.opt("soundId") as? String)?.takeIf(SOUND_ID::matches),
            kind = (json.opt("kind") as? String)?.takeIf(KINDS::contains),
            prayer = (json.opt("prayer") as? String)?.takeIf(PRAYERS::contains),
        )
    }

    private fun parseOccurrence(json: JSONObject): ScheduleOccurrence? {
        val id = json.opt("id") as? String ?: return null
        val parsedId = Instants.parseOccurrenceId(id) ?: return null
        val eventId = json.opt("eventId") as? String ?: return null
        val at = json.opt("at") as? String ?: return null
        // The id and the fields must agree: a list that disagrees with itself could ring one thing and complete another.
        if (!eventId.equals(parsedId.eventId, ignoreCase = true) || at != parsedId.occurrenceAt) return null

        val originalAt = (json.opt("originalAt") as? String)?.takeIf { text ->
            val ms = Instants.parse(text) ?: return@takeIf false
            val gap = Math.abs(ms - parsedId.atMs)
            gap > 0 && gap <= MAX_SHIFT_MS
        }
        val unlogged = (json.opt("labelIfUnlogged") as? JSONObject)?.let { value ->
            val previous = value.opt("id") as? String
            val label = (value.opt("label") as? String)?.takeIf { it.length in 1..200 }
            if (previous != null && label != null && Instants.parseOccurrenceId(previous) != null) {
                UnloggedLabel(previous, label)
            } else {
                null
            }
        }
        return ScheduleOccurrence(
            id = id,
            eventId = parsedId.eventId,
            at = at,
            atMs = parsedId.atMs,
            silenced = json.opt("silenced") == true,
            completed = json.opt("completed") == true,
            originalAt = originalAt,
            originalAtMs = originalAt?.let(Instants::parse),
            label = (json.opt("label") as? String)?.takeIf { it.length in 1..200 },
            labelIfUnlogged = unlogged,
        )
    }

    private fun clampedInt(value: Any?, min: Int, max: Int, fallback: Int): Int {
        val number = (value as? Number)?.toDouble() ?: return fallback
        if (number.isNaN()) return fallback
        return number.coerceIn(min.toDouble(), max.toDouble()).toInt()
    }

    /** The schedule in payload format (without the refill source), so [parse] reads back what was stored. */
    fun toJson(schedule: Schedule): JSONObject {
        val settings = schedule.settings
        val settingsJson = JSONObject()
            .put("user_id", settings.userId)
            .put("timezone", settings.timezone)
            .put("grace_minutes", settings.graceMinutes)
            .put("refire_seconds", settings.refireSeconds)
        settings.sound?.let { settingsJson.put("sound", it) }
        settings.prayerSound?.let { settingsJson.put("prayerSound", it) }

        val occurrences = JSONArray()
        for (o in schedule.occurrences) {
            val json = JSONObject()
                .put("id", o.id).put("eventId", o.eventId).put("at", o.at)
                .put("silenced", o.silenced).put("completed", o.completed)
            o.originalAt?.let { json.put("originalAt", it) }
            o.label?.let { json.put("label", it) }
            o.labelIfUnlogged?.let { json.put("labelIfUnlogged", JSONObject().put("id", it.id).put("label", it.label)) }
            occurrences.put(json)
        }
        val eventInfo = JSONObject()
        for ((eventId, info) in schedule.eventInfo) {
            val json = JSONObject()
                .put("title", info.title)
                .put("notes", info.notes ?: JSONObject.NULL)
                .put("maxSnoozes", info.maxSnoozes)
                .put("snoozeMinutes", info.snoozeMinutes)
                .put("soundId", info.soundId ?: JSONObject.NULL)
            info.kind?.let { json.put("kind", it) }
            info.prayer?.let { json.put("prayer", it) }
            eventInfo.put(eventId, json)
        }
        return JSONObject()
            .put("version", 2)
            .put("generatedAt", Instants.format(schedule.generatedAtMs))
            .put("horizonEnd", Instants.format(schedule.horizonEndMs))
            .put("truncated", schedule.truncated)
            .put("settings", settingsJson)
            .put("occurrences", occurrences)
            .put("eventInfo", eventInfo)
    }
}
