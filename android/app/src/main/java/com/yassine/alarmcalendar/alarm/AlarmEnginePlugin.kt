package com.yassine.alarmcalendar.alarm

import android.Manifest
import android.content.Intent
import android.os.Build
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.yassine.alarmcalendar.engine.EngineRuntime

/**
 * The native side of the app's AlarmAdapter (spec section 2): the app pushes the precomputed schedule, the engine
 * owns every ring from there on. Registered in MainActivity (a local plugin, not an npm package).
 */
@CapacitorPlugin(name = "AlarmEngine")
class AlarmEnginePlugin : Plugin() {
    /**
     * Stores a version 2 schedule payload (`{ payload }`), then rings whatever is due and schedules the next wake-up.
     * Rows that cannot be used are dropped one at a time and counted in the result; only an unusable envelope rejects.
     */
    @PluginMethod
    fun setSchedule(call: PluginCall) {
        val payload = call.getObject("payload") ?: return call.reject("payload is required")
        when (val result = AlarmHost.runtime(context).setSchedule(payload)) {
            is EngineRuntime.SetScheduleResult.Rejected -> call.reject(result.reason)
            is EngineRuntime.SetScheduleResult.Accepted -> {
                AlarmController.afterChange(context)
                call.resolve(
                    JSObject()
                        .put("accepted", true)
                        .put("dropped", JSObject().put("occurrences", result.dropped.occurrences).put("eventInfo", result.dropped.eventInfo)),
                )
            }
        }
    }

    /**
     * Completions made on this device that have not been acknowledged, without removing them. The app upserts them
     * (idempotent on event and occurrence) and then calls ackCompletions, so an upsert that fails or is interrupted
     * loses nothing: the next call returns the same rows.
     */
    @PluginMethod
    fun peekCompletions(call: PluginCall) {
        val rows = JSArray()
        for (c in AlarmHost.runtime(context).peekCompletions()) {
            rows.put(
                JSObject()
                    .put("id", c.id).put("user_id", c.userId).put("event_id", c.eventId)
                    .put("occurrence_at", c.occurrenceAt).put("status", c.status)
                    .put("snoozes_used", c.snoozesUsed).put("done_at", c.doneAt),
            )
        }
        call.resolve(JSObject().put("completions", rows))
    }

    /** Forgets the completions with these row ids (`{ ids }`), once the server has accepted them. */
    @PluginMethod
    fun ackCompletions(call: PluginCall) {
        val array = call.getArray("ids") ?: return call.reject("ids is required")
        val ids = (0 until array.length()).mapNotNull { array.optString(it).takeIf { id -> id.isNotEmpty() } }
        call.resolve(JSObject().put("acked", AlarmHost.runtime(context).ackCompletions(ids)))
    }

    /** Occurrence ids marked Done here that have not been acknowledged yet. */
    @PluginMethod
    fun getPendingDoneOccurrences(call: PluginCall) {
        val ids = JSArray()
        for (id in AlarmHost.runtime(context).pendingDoneOccurrenceIds()) ids.put(id)
        call.resolve(JSObject().put("ids", ids))
    }

    @PluginMethod
    fun getPermissionStatus(call: PluginCall) {
        val s = Permissions.snapshot(context)
        call.resolve(
            JSObject()
                .put("exactAlarm", s.exactAlarm)
                .put("fullScreenIntent", s.fullScreenIntent)
                .put("notifications", s.notifications)
                .put("batteryOptimizationExempt", s.batteryOptimizationExempt)
                // Beyond core's PermissionStatus: what the Xiaomi / HyperOS security center decides.
                .put(
                    "details",
                    JSObject()
                        .put("manufacturer", s.manufacturer)
                        .put("sdk", s.sdk)
                        .put("xiaomi", s.xiaomi)
                        .put("autostart", s.autostart)
                        .put("lockScreen", s.lockScreen)
                        .put("backgroundPopup", s.backgroundPopup)
                        .put("runtimeNotificationPermission", Permissions.hasRuntimeNotificationPermission(context)),
                ),
        )
    }

    /**
     * Opens the screen where `kind` is granted: exactAlarm, fullScreenIntent, notifications, batteryOptimization,
     * autostart, lockScreen or backgroundPopup (the last three are Xiaomi / HyperOS). Falls back to the app's own
     * settings page, which always exists. The first notifications request asks with the system dialog instead.
     */
    @PluginMethod
    fun openPermissionSettings(call: PluginCall) {
        val kind = call.getString("kind") ?: "appDetails"
        val activity = activity ?: return call.reject("no activity")
        if (kind == "notifications" && askForNotificationsOnce()) {
            call.resolve(JSObject().put("opened", "systemDialog").put("fallback", false))
            return
        }
        val candidates = Permissions.settingsIntents(context, kind)
        for ((index, intent) in candidates.withIndex()) {
            try {
                activity.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                call.resolve(JSObject().put("opened", kind).put("fallback", index == candidates.lastIndex && kind != "appDetails"))
                return
            } catch (e: Exception) {
                // ActivityNotFoundException, or SecurityException for a screen that is not exported on this build.
                AlarmHost.log("permission.settings_unavailable", mapOf("kind" to kind, "candidate" to index, "error" to e.javaClass.simpleName))
            }
        }
        call.reject("no settings screen could be opened for $kind")
    }

    // Android shows its permission dialog only until the user has said no twice; after that the settings page is the way.
    private fun askForNotificationsOnce(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || Permissions.hasRuntimeNotificationPermission(context)) return false
        val prefs = context.getSharedPreferences("alarm-engine-prefs", android.content.Context.MODE_PRIVATE)
        if (prefs.getBoolean("notifications_requested", false)) return false
        prefs.edit().putBoolean("notifications_requested", true).apply()
        activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
        return true
    }

    private companion object {
        const val REQUEST_NOTIFICATIONS = 4101
    }
}
