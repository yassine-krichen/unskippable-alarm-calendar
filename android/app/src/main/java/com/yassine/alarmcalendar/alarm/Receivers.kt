package com.yassine.alarmcalendar.alarm

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager

/** The alarm-clock alarm for the soonest due instant went off. */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Notifications.ACTION_RINGING_DISMISSED) {
            // The ringing notification was swiped away: the service puts it back (or starts again if it is gone).
            AlarmController.afterChange(context)
            return
        }
        if (intent.action != AlarmScheduler.ACTION_FIRE) return
        // Held until the service has taken over (it keeps its own lock while ringing); released by the timeout.
        context.getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "alarmcalendar:fire")
            .acquire(WAKE_LOCK_MS)
        AlarmHost.log("receiver.fire")
        AlarmController.onAlarmFired(context)
    }

    private companion object {
        const val WAKE_LOCK_MS = 15_000L
    }
}

/**
 * Alarms set with AlarmManager do not survive a reboot or an app update, and a clock or zone change moves what is
 * due. Everything is rebuilt from local storage; nothing needs the network or the app.
 */
@SuppressLint("InlinedApi")
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action !in HANDLED) return
        AlarmHost.log("receiver.reschedule", mapOf("action" to action))
        AlarmController.reschedule(context)
    }

    private companion object {
        val HANDLED = setOf(
            // Before the first unlock (direct boot) and after it; the second finds nothing new, which is harmless.
            Intent.ACTION_LOCKED_BOOT_COMPLETED,
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED,
            AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED,
        )
    }
}

/** Coarse daily check that tells the user when the schedule is running out. */
class HorizonCheckReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != AlarmScheduler.ACTION_HORIZON_CHECK) return
        AlarmController.updateHorizon(context)
    }
}
