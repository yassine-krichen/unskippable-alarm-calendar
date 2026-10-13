package com.yassine.alarmcalendar.alarm

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/**
 * What happens after anything that can change the engine: schedule the next wake-up, make the foreground service
 * match the alarms that are ringing, and keep the horizon notice current. Every path that rings goes through an
 * AlarmManager alarm (even "ring now" after a reboot is an alarm in the past), because an alarm-clock alarm is what
 * lets the app start its foreground service from the background.
 */
object AlarmController {
    private const val SERVICE_RETRY_MS = 10_000L

    /** The alarm for the soonest due instant went off. */
    fun onAlarmFired(context: Context) {
        AlarmHost.runtime(context).evaluate()
        afterChange(context)
    }

    /** Boot, app update, clock or zone change: nothing rings here, the next alarm is only (re)scheduled. */
    fun reschedule(context: Context) {
        val runtime = AlarmHost.runtime(context)
        AlarmScheduler.scheduleNext(context, runtime.nextTriggerAt())
        updateHorizon(context)
    }

    fun afterChange(context: Context) {
        val runtime = AlarmHost.runtime(context)
        AlarmScheduler.scheduleNext(context, runtime.nextTriggerAt())
        updateHorizon(context)
        syncService(context)
    }

    fun done(context: Context, occurrenceId: String) {
        AlarmHost.runtime(context).done(occurrenceId)
        afterChange(context)
    }

    fun snooze(context: Context, occurrenceId: String) {
        AlarmHost.runtime(context).snooze(occurrenceId)
        afterChange(context)
    }

    /** The alarm screen went away without Done or Snooze: ring again after the refire delay. */
    fun windowClosed(context: Context, occurrenceId: String) {
        AlarmHost.runtime(context).windowClosed(occurrenceId)
        afterChange(context)
    }

    fun updateHorizon(context: Context) {
        val runtime = AlarmHost.runtime(context)
        if (runtime.takeHorizonNotice()) {
            Notifications.horizonNotice(context, runtime.horizonEndMs(), runtime.settings()?.timezone ?: "UTC")
        }
        AlarmScheduler.scheduleHorizonCheck(context, runtime.nextHorizonCheckAt())
    }

    /** The alarm screen, if anything rings. Called when the app is opened (MainActivity.onResume): the way back to a ringing alarm. */
    @JvmStatic
    fun showIfRinging(context: Context) {
        if (AlarmHost.runtime(context).activeRinging().isEmpty()) return
        try {
            context.startActivity(AlarmActivity.intent(context))
        } catch (e: Exception) {
            AlarmHost.log("activity.show_failed", mapOf("error" to e.javaClass.simpleName))
        }
    }

    /** Try again shortly, without pushing back anything the engine wants sooner. */
    fun scheduleRetry(context: Context) {
        val soon = System.currentTimeMillis() + SERVICE_RETRY_MS
        AlarmScheduler.scheduleNext(context, minOf(soon, AlarmHost.runtime(context).nextTriggerAt() ?: soon))
    }

    private fun syncService(context: Context) {
        val running = AlarmService.instance
        if (running != null) {
            // The service decides what to show and whether to stop; this is true for a new alarm and for a Done.
            running.requestSync()
            return
        }
        if (AlarmHost.runtime(context).activeRinging().isEmpty()) return
        try {
            ContextCompat.startForegroundService(context, Intent(context, AlarmService::class.java).setAction(AlarmService.ACTION_SYNC))
        } catch (e: Exception) {
            // Not allowed to start it right now. The alarm must not be lost: try again shortly.
            AlarmHost.log("service.start_failed", mapOf("error" to e.javaClass.simpleName))
            scheduleRetry(context)
        }
    }
}
