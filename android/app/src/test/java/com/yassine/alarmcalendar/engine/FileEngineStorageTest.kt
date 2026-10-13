package com.yassine.alarmcalendar.engine

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class FileEngineStorageTest {
    @get:Rule
    val folder = TemporaryFolder()

    private fun storage() = FileEngineStorage(File(folder.root, "alarm-engine"))

    @Test
    fun writesAndReadsBothFiles() {
        val storage = storage()
        assertNull(storage.readSchedule())
        assertNull(storage.readState())
        storage.writeSchedule("{\"a\":1}")
        storage.writeState("{\"b\":2}")
        assertEquals("{\"a\":1}", storage.readSchedule())
        assertEquals("{\"b\":2}", storage.readState())
    }

    @Test
    fun replacingAFileLeavesNoTemporaryFileBehind() {
        val storage = storage()
        storage.writeState("one")
        storage.writeState("two")
        assertEquals("two", storage.readState())
        assertEquals(listOf("state.json"), File(folder.root, "alarm-engine").list()!!.toList())
    }

    @Test
    fun aLeftOverTemporaryFileFromACrashNeverShadowsTheRealOne() {
        val storage = storage()
        storage.writeState("good")
        File(folder.root, "alarm-engine/state.json.tmp").writeText("half writ")
        assertEquals("good", storage.readState())
        storage.writeState("newer")
        assertEquals("newer", storage.readState())
    }

    @Test
    fun quarantineKeepsTheUnreadableFileUnderAnotherName() {
        val storage = storage()
        storage.writeSchedule("garbage")
        storage.quarantineSchedule()
        assertNull(storage.readSchedule())
        val names = File(folder.root, "alarm-engine").list()!!.toList()
        assertTrue(names.single().startsWith("schedule.json.corrupt-"))
    }

    @Test
    fun clearRemovesBothFiles() {
        val storage = storage()
        storage.writeSchedule("x")
        storage.writeState("y")
        storage.clear()
        assertFalse(File(folder.root, "alarm-engine/schedule.json").exists())
        assertFalse(File(folder.root, "alarm-engine/state.json").exists())
    }

    @Test
    fun filesOfAnOlderInstallMoveToTheNewFolderOnceAndNothingIsOverwritten() {
        val legacy = File(folder.root, "legacy").apply { mkdirs() }
        File(legacy, "schedule.json").writeText("old schedule")
        File(legacy, "state.json").writeText("old state")
        val target = File(folder.root, "device-protected/alarm-engine")
        assertTrue(StorageMigration.migrate(legacy, target))
        assertEquals("old schedule", File(target, "schedule.json").readText())
        assertEquals("old state", File(target, "state.json").readText())
        assertFalse(legacy.exists())
        assertEquals(setOf("schedule.json", "state.json"), target.list()!!.toSet())

        // A second run (nothing left to move) is a no-op, and files already in place are never replaced.
        assertTrue(StorageMigration.migrate(legacy, target))
        legacy.mkdirs()
        File(legacy, "state.json").writeText("stale state")
        assertTrue(StorageMigration.migrate(legacy, target))
        assertEquals("old state", File(target, "state.json").readText())
        assertFalse(legacy.exists())
    }

    @Test
    fun theEngineRunsOverRealFilesAcrossARestart() {
        val files = storage()
        // Same scenario on disk: push, ring, snooze, "kill the process", ring again from the files alone.
        val payload = Fixtures.payload(
            listOf(Fixtures.occurrence(Fixtures.EVENT_A, 60)),
            mapOf(Fixtures.EVENT_A to Fixtures.info(maxSnoozes = 2, snoozeMinutes = 1)),
        )
        var now = Fixtures.baseMs
        val first = EngineRuntime(files, { now }, { _, _ -> }, { "00000000-0000-4000-8000-000000000001" })
        first.setSchedule(payload)
        now += 60_000
        first.evaluate()
        first.snooze(first.activeRinging().single().occurrenceId)

        now += 60_000
        val second = EngineRuntime(files, { now }, { _, _ -> }, { "00000000-0000-4000-8000-000000000002" })
        assertEquals(1, second.evaluate().size)
        assertEquals(1, second.activeRinging().single().snoozesUsed)
    }
}
