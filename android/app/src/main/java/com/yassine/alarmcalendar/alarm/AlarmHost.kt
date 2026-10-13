package com.yassine.alarmcalendar.alarm

import android.content.Context
import android.os.UserManager
import android.util.Log
import com.yassine.alarmcalendar.engine.EngineRuntime
import com.yassine.alarmcalendar.engine.FileEngineStorage
import com.yassine.alarmcalendar.engine.StorageMigration
import java.io.File
import java.util.UUID

/**
 * The one [EngineRuntime] of the process. Every component (plugin, receivers, service, alarm screen) reaches the
 * engine through here, so the state is loaded once and all access shares its lock. The files live in app-private
 * storage (credential encrypted): after a reboot the alarms resume once the phone is first unlocked.
 */
object AlarmHost {
    const val TAG = "AlarmEngine"

    @Volatile
    private var runtime: EngineRuntime? = null

    fun runtime(context: Context): EngineRuntime =
        runtime ?: synchronized(this) {
            runtime ?: create(context.applicationContext).also { runtime = it }
        }

    private fun create(app: Context): EngineRuntime {
        val created = EngineRuntime(
            storage = FileEngineStorage(storageDir(app)),
            clock = System::currentTimeMillis,
            log = ::log,
            newId = { UUID.randomUUID().toString() },
        )
        // A new process has just loaded the state. If an alarm was on screen when the last process died, the engine
        // has made it due at once, and nothing else would wake it (the system only restarts the service). Setting the
        // alarm again is idempotent, so this is also a free self-heal on every process start.
        AlarmScheduler.scheduleNext(app, created.nextTriggerAt())
        return created
    }

    /**
     * Device-protected storage, so the alarms can ring after a reboot before the first unlock (direct boot). The
     * schedule, with the alarm titles and notes, is therefore readable on the phone while it is locked: a deliberate
     * trade for an alarm clock on the owner's own phone (docs/decisions.md). Files of an older install are moved over as
     * soon as credential-protected storage is available.
     */
    private fun storageDir(app: Context): File {
        val target = File(app.createDeviceProtectedStorageContext().filesDir, "alarm-engine")
        if (app.getSystemService(UserManager::class.java).isUserUnlocked) {
            StorageMigration.migrate(File(app.filesDir, "alarm-engine"), target)
        }
        return target
    }

    /** Structured one-line logs (`event key=value ...`). Never titles or notes. */
    fun log(event: String, fields: Map<String, Any?> = emptyMap()) {
        val line = if (fields.isEmpty()) event else event + " " + fields.entries.joinToString(" ") { "${it.key}=${it.value}" }
        Log.i(TAG, line)
    }
}
