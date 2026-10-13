package com.yassine.alarmcalendar.alarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.yassine.alarmcalendar.engine.Instants
import org.json.JSONArray
import org.json.JSONObject

/**
 * Debug builds only. Drives the engine from `adb shell am broadcast` so the native side can be proven on a device
 * without the app's UI (stage 1):
 *
 *   SEED   a schedule with an alarm in `a` seconds (2 snoozes of 1 min), a no-snooze alarm in `b` seconds, and
 *          refire of `refire` seconds. Extras (all optional): --ei a 60  --ei b 90  --ei refire 20  --ei grace 30
 *   CLEAR  forgets the schedule and every state, cancels the alarm and stops the service
 *   DUMP   prints the engine state to logcat (tag AlarmEngine, lines "dump ...")
 *   CLOSE_SCREEN  finishes the alarm screen without a choice (the swiped-away path)
 *   PERMS  prints the permission status (what getPermissionStatus returns) to logcat, "perms ..." lines
 *
 * The seed goes through the same parser and the same engine entry as the plugin's setSchedule.
 */
class DebugSeedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val runtime = AlarmHost.runtime(context)
        when (intent.action) {
            ACTION_SEED -> {
                val payload = seedPayload(
                    now = System.currentTimeMillis(),
                    aSeconds = intent.getIntExtra("a", 60),
                    bSeconds = intent.getIntExtra("b", 90),
                    refireSeconds = intent.getIntExtra("refire", 20),
                    graceMinutes = intent.getIntExtra("grace", 30),
                )
                val result = runtime.setSchedule(payload)
                AlarmController.afterChange(context)
                Log.i(AlarmHost.TAG, "debug.seed result=${result.javaClass.simpleName}")
            }
            ACTION_CLEAR -> {
                runtime.clear()
                AlarmScheduler.scheduleNext(context, null)
                AlarmScheduler.scheduleHorizonCheck(context, null)
                AlarmController.afterChange(context)
                Log.i(AlarmHost.TAG, "debug.cleared")
            }
            ACTION_DUMP -> runtime.dump().lines().forEach { Log.i(AlarmHost.TAG, "dump $it") }
            ACTION_CLOSE_SCREEN -> AlarmActivity.current?.finishAndRemoveTask()
            ACTION_PERMS -> {
                val p = Permissions.snapshot(context)
                Log.i(
                    AlarmHost.TAG,
                    "perms exactAlarm=${p.exactAlarm} fullScreenIntent=${p.fullScreenIntent} notifications=${p.notifications} " +
                        "battery=${p.batteryOptimizationExempt} manufacturer=${p.manufacturer} sdk=${p.sdk} xiaomi=${p.xiaomi} " +
                        "autostart=${p.autostart} lockScreen=${p.lockScreen} backgroundPopup=${p.backgroundPopup}",
                )
            }
        }
    }

    private fun seedPayload(now: Long, aSeconds: Int, bSeconds: Int, refireSeconds: Int, graceMinutes: Int): JSONObject {
        val wholeSecond = (now + 999) / 1000 * 1000
        fun occurrence(eventId: String, seconds: Int): JSONObject {
            val at = Instants.format(wholeSecond + seconds * 1000L)
            return JSONObject().put("id", "$eventId@$at").put("eventId", eventId).put("at", at).put("silenced", false).put("completed", false)
        }
        fun info(title: String, maxSnoozes: Int) = JSONObject()
            .put("title", title).put("notes", "Debug seed").put("maxSnoozes", maxSnoozes).put("snoozeMinutes", 1).put("soundId", "bell")
        return JSONObject()
            .put("version", 2)
            .put("generatedAt", Instants.format(now))
            .put("horizonEnd", Instants.format(now + 60 * Instants.MS_PER_DAY))
            .put("truncated", false)
            .put(
                "settings",
                JSONObject().put("user_id", USER_ID).put("timezone", "Africa/Tunis").put("week_starts_on", 0)
                    .put("refire_seconds", refireSeconds).put("pass_cap", 2).put("grace_minutes", graceMinutes).put("sound", "bell"),
            )
            .put("occurrences", JSONArray().put(occurrence(EVENT_A, aSeconds)).put(occurrence(EVENT_B, bSeconds)))
            .put(
                "eventInfo",
                JSONObject().put(EVENT_A, info("Dev alarm: 2 snoozes of 1 min", 2)).put(EVENT_B, info("Dev alarm: no snooze, do it now", 0)),
            )
    }

    private companion object {
        const val ACTION_SEED = "com.yassine.alarmcalendar.debug.SEED"
        const val ACTION_CLEAR = "com.yassine.alarmcalendar.debug.CLEAR"
        const val ACTION_DUMP = "com.yassine.alarmcalendar.debug.DUMP"
        const val ACTION_CLOSE_SCREEN = "com.yassine.alarmcalendar.debug.CLOSE_SCREEN"
        const val ACTION_PERMS = "com.yassine.alarmcalendar.debug.PERMS"
        const val USER_ID = "00000000-0000-4000-8000-000000000001"
        const val EVENT_A = "00000000-0000-4000-8000-0000000000a1"
        const val EVENT_B = "00000000-0000-4000-8000-0000000000a2"
    }
}
