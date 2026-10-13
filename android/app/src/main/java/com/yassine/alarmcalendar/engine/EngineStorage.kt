package com.yassine.alarmcalendar.engine

import java.io.File
import java.io.FileOutputStream
import org.json.JSONArray
import org.json.JSONObject

/**
 * Where the engine keeps its two files, mirroring electron's split: the schedule (big, replaced as a whole by a
 * push) and the state (small, rewritten on every ring, snooze or Done). Each is written atomically: temp file,
 * fsync, rename. Plain JSON files rather than Room: the data is replaced whole or tiny, nothing is queried, and it
 * adds no dependency or annotation processor.
 */
interface EngineStorage {
    fun readSchedule(): String?
    fun writeSchedule(json: String)
    fun readState(): String?
    fun writeState(json: String)
    /** Sets a file that cannot be read aside (instead of deleting it) so the engine starts empty and the evidence stays. */
    fun quarantineSchedule()
    fun quarantineState()
    fun clear()
}

class FileEngineStorage(private val dir: File) : EngineStorage {
    private val scheduleFile get() = File(dir, "schedule.json")
    private val stateFile get() = File(dir, "state.json")

    override fun readSchedule(): String? = read(scheduleFile)
    override fun writeSchedule(json: String) = writeAtomically(scheduleFile, json)
    override fun readState(): String? = read(stateFile)
    override fun writeState(json: String) = writeAtomically(stateFile, json)
    override fun quarantineSchedule() = moveAside(scheduleFile)
    override fun quarantineState() = moveAside(stateFile)

    override fun clear() {
        scheduleFile.delete()
        stateFile.delete()
    }

    private fun read(file: File): String? = if (file.isFile) file.readText(Charsets.UTF_8) else null

    private fun writeAtomically(target: File, text: String) {
        dir.mkdirs()
        val temp = File(dir, target.name + ".tmp")
        FileOutputStream(temp).use { out ->
            out.write(text.toByteArray(Charsets.UTF_8))
            out.fd.sync()
        }
        // rename(2) within one directory replaces the target atomically; a crash leaves the old or the new file.
        if (!temp.renameTo(target)) {
            target.delete()
            check(temp.renameTo(target)) { "cannot replace ${target.name}" }
        }
    }

    private fun moveAside(file: File) {
        if (file.isFile) file.renameTo(File(dir, file.name + ".corrupt-" + System.currentTimeMillis()))
    }
}

/** JSON form of [EngineState]. Lenient on read: a field that is missing or malformed is skipped, never fatal. */
object StateCodec {
    fun toJson(state: EngineState): JSONObject {
        val occurrences = JSONArray()
        for (s in state.occurrences) {
            occurrences.put(
                JSONObject()
                    .put("eventId", s.eventId)
                    .put("occurrenceAt", s.occurrenceAt)
                    .put("snoozesUsed", s.snoozesUsed)
                    .put("phase", s.phase.name.lowercase())
                    .put("wakeAt", s.wakeAtMs?.let(Instants::format) ?: JSONObject.NULL)
                    .put("userId", s.userId)
                    .put("title", s.title)
                    .put("notes", s.notes ?: JSONObject.NULL)
                    .put("maxSnoozes", s.maxSnoozes)
                    .put("snoozeMinutes", s.snoozeMinutes)
                    .put("soundId", s.soundId ?: JSONObject.NULL)
                    .put("kind", s.kind ?: JSONObject.NULL)
                    .put("labelled", s.labelled)
            )
        }
        val handled = JSONObject()
        for ((eventId, ms) in state.handledThrough) handled.put(eventId, Instants.format(ms))
        val pending = JSONArray()
        for (c in state.pendingCompletions) {
            pending.put(
                JSONObject()
                    .put("id", c.id).put("user_id", c.userId).put("event_id", c.eventId)
                    .put("occurrence_at", c.occurrenceAt).put("status", c.status)
                    .put("snoozes_used", c.snoozesUsed).put("done_at", c.doneAt)
            )
        }
        return JSONObject()
            .put("version", 1)
            .put("occurrences", occurrences)
            .put("handledThrough", handled)
            .put("pendingCompletions", pending)
            .put("knownCompletions", JSONArray(state.knownCompletions))
            .put("lastHorizonNoticeAt", state.lastHorizonNoticeAtMs)
    }

    fun fromJson(root: JSONObject): EngineState {
        val state = EngineState()
        root.optJSONArray("occurrences")?.let { array ->
            for (i in 0 until array.length()) {
                val json = array.optJSONObject(i) ?: continue
                val eventId = json.optString("eventId", "")
                val occurrenceAt = json.optString("occurrenceAt", "")
                if (!Instants.isUuid(eventId) || Instants.parseOccurrenceId("$eventId@$occurrenceAt") == null) continue
                val phase = if (json.optString("phase") == "snoozed") Phase.SNOOZED else Phase.RINGING
                state.occurrences.add(
                    OccurrenceState(
                        eventId = eventId,
                        occurrenceAt = occurrenceAt,
                        snoozesUsed = json.optInt("snoozesUsed", 0),
                        phase = phase,
                        wakeAtMs = (json.opt("wakeAt") as? String)?.let(Instants::parse),
                        userId = json.optString("userId", ""),
                        title = json.optString("title", "Alarm").ifBlank { "Alarm" },
                        notes = json.opt("notes") as? String,
                        maxSnoozes = json.optInt("maxSnoozes", 0),
                        snoozeMinutes = json.optInt("snoozeMinutes", 5).coerceAtLeast(1),
                        soundId = json.opt("soundId") as? String,
                        kind = json.opt("kind") as? String,
                        labelled = json.optBoolean("labelled", false),
                    )
                )
            }
        }
        root.optJSONObject("handledThrough")?.let { handled ->
            for (eventId in handled.keys()) {
                (handled.opt(eventId) as? String)?.let(Instants::parse)?.let { state.handledThrough[eventId] = it }
            }
        }
        root.optJSONArray("pendingCompletions")?.let { array ->
            for (i in 0 until array.length()) {
                val json = array.optJSONObject(i) ?: continue
                state.pendingCompletions.add(
                    Completion(
                        id = json.optString("id", ""),
                        userId = json.optString("user_id", ""),
                        eventId = json.optString("event_id", ""),
                        occurrenceAt = json.optString("occurrence_at", ""),
                        status = json.optString("status", "done"),
                        snoozesUsed = json.optInt("snoozes_used", 0),
                        doneAt = json.optString("done_at", ""),
                    )
                )
            }
        }
        root.optJSONArray("knownCompletions")?.let { array ->
            for (i in 0 until array.length()) (array.opt(i) as? String)?.let(state.knownCompletions::add)
        }
        state.lastHorizonNoticeAtMs = root.optLong("lastHorizonNoticeAt", 0L)
        return state
    }
}

/**
 * The engine files used to live in credential-protected storage (`filesDir`), which is locked until the first unlock
 * after a boot. They now live in device-protected storage so the alarms can ring before that. This copies the files
 * of an older install across, once, and never overwrites files that already exist in the new place.
 */
object StorageMigration {
    private val NAMES = listOf("schedule.json", "state.json")

    /** Returns true if the legacy folder is gone afterwards (or never existed). */
    fun migrate(legacyDir: File, targetDir: File): Boolean {
        if (!legacyDir.isDirectory) return true
        targetDir.mkdirs()
        for (name in NAMES) {
            val from = File(legacyDir, name)
            val to = File(targetDir, name)
            if (from.isFile && !to.exists()) {
                // Copy to a temporary name first, so a crash cannot leave half a file under the real one.
                val temp = File(targetDir, "$name.migrating")
                from.copyTo(temp, overwrite = true)
                if (!temp.renameTo(to)) {
                    temp.delete()
                    return false
                }
            }
        }
        return legacyDir.deleteRecursively()
    }
}
