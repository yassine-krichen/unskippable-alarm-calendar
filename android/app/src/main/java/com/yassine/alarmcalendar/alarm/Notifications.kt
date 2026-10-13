package com.yassine.alarmcalendar.alarm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.text.format.DateFormat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.yassine.alarmcalendar.MainActivity
import com.yassine.alarmcalendar.R
import com.yassine.alarmcalendar.engine.AlarmView
import java.util.Date
import java.util.Locale
import java.util.TimeZone

object Notifications {
    /** The sound is played by the service on the alarm stream, so the channel itself is silent. */
    const val CHANNEL_RINGING = "alarm_ringing"
    const val CHANNEL_SCHEDULE = "alarm_schedule"
    const val ID_RINGING = 4101
    const val ACTION_RINGING_DISMISSED = "com.yassine.alarmcalendar.action.RINGING_DISMISSED"
    const val ID_HORIZON = 4102

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        val ringing = NotificationChannel(CHANNEL_RINGING, "Ringing alarms", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Shown while an alarm is ringing. Keep this on, or the alarm screen cannot open over the lock screen."
            setSound(null, null)
            enableVibration(false)
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        val schedule = NotificationChannel(CHANNEL_SCHEDULE, "Schedule reminders", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Asks you to open the app when your alarms are about to run out of schedule."
        }
        manager.createNotificationChannels(listOf(ringing, schedule))
    }

    fun ringing(context: Context, front: AlarmView, others: Int, timeZone: String): Notification {
        ensureChannels(context)
        val open = PendingIntent.getActivity(
            context, 10, AlarmActivity.intent(context),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val time = TimeText.time(context, front.occurrenceAtMs, timeZone)
        val text = if (others > 0) "$time · $others more ringing" else time
        return NotificationCompat.Builder(context, CHANNEL_RINGING)
            .setSmallIcon(R.drawable.ic_alarm_notification)
            .setContentTitle(front.title)
            .setContentText(text)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setAutoCancel(false)
            .setContentIntent(open)
            .setFullScreenIntent(open, true)
            // Swiped away (Android 14 lets the user dismiss a foreground service notification): put it back.
            .setDeleteIntent(
                PendingIntent.getBroadcast(
                    context, 12, Intent(context, AlarmReceiver::class.java).setAction(ACTION_RINGING_DISMISSED),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    fun clearHorizonNotice(context: Context) {
        NotificationManagerCompat.from(context).cancel(ID_HORIZON)
    }

    /** Posted when under 7 days of schedule are left: the engine cannot expand recurrences by itself. */
    fun horizonNotice(context: Context, horizonEndMs: Long?, timeZone: String) {
        ensureChannels(context)
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        val open = PendingIntent.getActivity(
            context, 11, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val expired = horizonEndMs != null && horizonEndMs <= System.currentTimeMillis()
        val body = when {
            horizonEndMs == null -> "Your alarms need a refresh."
            expired -> "Your alarms have run out of schedule and will not ring until you open the app."
            else -> "Your alarms are scheduled until ${TimeText.date(horizonEndMs, timeZone)}. Open the app to extend them."
        }
        val notification = NotificationCompat.Builder(context, CHANNEL_SCHEDULE)
            .setSmallIcon(R.drawable.ic_alarm_notification)
            .setContentTitle("Open Alarm Calendar to keep your alarms scheduled")
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(ID_HORIZON, notification)
        } catch (e: SecurityException) {
            AlarmHost.log("notification.horizon_denied")
        }
    }
}

object TimeText {
    /** The alarm's wall time in the user's time zone, in the device's 12 or 24 hour style. */
    fun time(context: Context, epochMs: Long, timeZone: String): String {
        val format = DateFormat.getTimeFormat(context)
        format.timeZone = TimeZone.getTimeZone(timeZone)
        return format.format(Date(epochMs))
    }

    fun date(epochMs: Long, timeZone: String): String {
        val pattern = DateFormat.getBestDateTimePattern(Locale.getDefault(), "EEEdMMM")
        val format = java.text.SimpleDateFormat(pattern, Locale.getDefault())
        format.timeZone = TimeZone.getTimeZone(timeZone)
        return format.format(Date(epochMs))
    }
}
