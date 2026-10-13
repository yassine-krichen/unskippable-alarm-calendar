package com.yassine.alarmcalendar.alarm

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.yassine.alarmcalendar.MainActivity

/**
 * Only the soonest due instant is ever scheduled (an occurrence, a snooze wake-up or a re-fire), with
 * AlarmManager.setAlarmClock: Doze exempt, and it shows the alarm icon in the status bar. When it fires the
 * receiver evaluates the engine and schedules the next one, so there is never more than one alarm outstanding.
 */
object AlarmScheduler {
    const val ACTION_FIRE = "com.yassine.alarmcalendar.action.FIRE"
    const val ACTION_HORIZON_CHECK = "com.yassine.alarmcalendar.action.HORIZON_CHECK"

    private const val REQUEST_FIRE = 1
    private const val REQUEST_SHOW = 2
    private const val REQUEST_HORIZON = 3

    /** Schedules the next wake-up at `triggerAtMs`, or cancels the pending one for null. A past instant fires at once. */
    fun scheduleNext(context: Context, triggerAtMs: Long?) {
        val alarmManager = context.getSystemService(AlarmManager::class.java)
        val fire = firePendingIntent(context)
        if (triggerAtMs == null) {
            alarmManager.cancel(fire)
            AlarmHost.log("alarm.cancelled")
            return
        }
        val at = maxOf(triggerAtMs, System.currentTimeMillis() + MIN_DELAY_MS)
        val show = PendingIntent.getActivity(
            context, REQUEST_SHOW, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        try {
            alarmManager.setAlarmClock(AlarmManager.AlarmClockInfo(at, show), fire)
            AlarmHost.log("alarm.scheduled", mapOf("at" to com.yassine.alarmcalendar.engine.Instants.format(at)))
        } catch (e: SecurityException) {
            // Exact alarms are not allowed (the permission was revoked). An inexact alarm that still survives
            // Doze beats no alarm; the permission panel tells the user what is missing.
            AlarmHost.log("alarm.exact_not_allowed", mapOf("error" to e.message))
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire)
        }
    }

    /** A coarse, Doze-tolerant wake-up for the horizon notice; it needs no exact alarm permission. */
    fun scheduleHorizonCheck(context: Context, atMs: Long?) {
        val alarmManager = context.getSystemService(AlarmManager::class.java)
        val pending = PendingIntent.getBroadcast(
            context, REQUEST_HORIZON,
            Intent(context, HorizonCheckReceiver::class.java).setAction(ACTION_HORIZON_CHECK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        if (atMs == null) alarmManager.cancel(pending) else alarmManager.setAndAllowWhileIdle(AlarmManager.RTC, atMs, pending)
    }

    fun canScheduleExact(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S || context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()

    private fun firePendingIntent(context: Context): PendingIntent =
        PendingIntent.getBroadcast(
            context, REQUEST_FIRE,
            Intent(context, AlarmReceiver::class.java).setAction(ACTION_FIRE),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    // A zero delay is allowed, but a few hundred milliseconds keep an evaluate-and-reschedule loop from ever spinning.
    private const val MIN_DELAY_MS = 250L
}
