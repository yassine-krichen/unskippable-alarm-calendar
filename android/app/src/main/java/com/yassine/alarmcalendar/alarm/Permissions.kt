package com.yassine.alarmcalendar.alarm

import android.annotation.SuppressLint
import android.app.AppOpsManager
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat

/**
 * What the device must allow for an alarm to ring reliably, and the settings screens that fix each one. The four
 * platform checks are exact (they match core's PermissionStatus). The Xiaomi / HyperOS ones are best effort: the
 * switches live in the security center, are read through the same hidden app-ops the center uses, and report
 * "unknown" when this build of the OS does not answer.
 */
object Permissions {
    class Snapshot(
        val exactAlarm: Boolean,
        val fullScreenIntent: Boolean,
        val notifications: Boolean,
        val batteryOptimizationExempt: Boolean,
        val manufacturer: String,
        val sdk: Int,
        val xiaomi: Boolean,
        val autostart: String,
        val lockScreen: String,
        val backgroundPopup: String,
    )

    fun snapshot(context: Context): Snapshot {
        val xiaomi = isXiaomi()
        return Snapshot(
            exactAlarm = AlarmScheduler.canScheduleExact(context),
            fullScreenIntent = canUseFullScreenIntent(context),
            notifications = notificationsEnabled(context),
            batteryOptimizationExempt = context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName),
            manufacturer = Build.MANUFACTURER,
            sdk = Build.VERSION.SDK_INT,
            xiaomi = xiaomi,
            autostart = if (xiaomi) miuiOp(context, OP_AUTO_START) else "notApplicable",
            lockScreen = if (xiaomi) miuiOp(context, OP_SHOW_WHEN_LOCKED) else "notApplicable",
            backgroundPopup = if (xiaomi) miuiOp(context, OP_BACKGROUND_START_ACTIVITY) else "notApplicable",
        )
    }

    /** USE_FULL_SCREEN_INTENT is a normal permission up to Android 13; from 14 the user (or the store) can revoke it. */
    fun canUseFullScreenIntent(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE ||
            context.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()

    /** Notifications on for the app and the ringing channel not switched off: the full-screen intent rides on it. */
    fun notificationsEnabled(context: Context): Boolean {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
        val channel = context.getSystemService(NotificationManager::class.java).getNotificationChannel(Notifications.CHANNEL_RINGING)
        return channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE
    }

    fun isXiaomi(): Boolean = Build.MANUFACTURER.lowercase() in setOf("xiaomi", "redmi", "poco")

    /** The screens to try for a permission, best first. The last entry always resolves: the app's own settings page. */
    @SuppressLint("InlinedApi")
    fun settingsIntents(context: Context, kind: String): List<Intent> {
        val pkg = context.packageName
        val uri = Uri.parse("package:$pkg")
        val appDetails = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, uri)
        val specific: List<Intent> = when (kind) {
            "exactAlarm" ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) listOf(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, uri)) else emptyList()
            "fullScreenIntent" ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) listOf(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, uri)) else emptyList()
            // The dedicated notification settings screen exists from Android 8; older versions fall to the app page.
            "notifications" -> listOf(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg))
            "batteryOptimization" -> buildList {
                if (isXiaomi()) add(miuiPowerKeeper(pkg))
                add(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, uri))
                add(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            }
            "autostart" -> if (isXiaomi()) {
                listOf(
                    Intent().setComponent(ComponentName(MIUI_SECURITY, "com.miui.permcenter.autostart.AutoStartManagementActivity")),
                    Intent("miui.intent.action.OP_AUTO_START").addCategory(Intent.CATEGORY_DEFAULT),
                )
            } else {
                emptyList()
            }
            // "Display on lock screen" and "Display pop-up windows while running in the background" are both on the
            // security center's permission editor page for the app.
            "lockScreen", "backgroundPopup" -> if (isXiaomi()) miuiPermissionEditors(pkg) else emptyList()
            else -> emptyList()
        }
        return specific + appDetails
    }

    private fun miuiPowerKeeper(pkg: String): Intent =
        Intent().setComponent(ComponentName("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity"))
            .putExtra("package_name", pkg)
            .putExtra("package_label", "Alarm Calendar")

    private fun miuiPermissionEditors(pkg: String): List<Intent> = listOf(
        Intent("miui.intent.action.APP_PERM_EDITOR")
            .setClassName(MIUI_SECURITY, "com.miui.permcenter.permissions.PermissionsEditorActivity")
            .putExtra("extra_pkgname", pkg),
        Intent("miui.intent.action.APP_PERM_EDITOR")
            .setClassName(MIUI_SECURITY, "com.miui.permcenter.permissions.AppPermissionsEditorActivity")
            .putExtra("extra_pkgname", pkg),
        Intent("miui.intent.action.APP_PERM_EDITOR").putExtra("extra_pkgname", pkg),
    )

    /**
     * Reads one of MIUI's own app-ops (the ones its security center toggles) through the hidden
     * AppOpsManager.checkOpNoThrow(int, int, String). Any failure, including the platform refusing the reflective
     * call, is "unknown" and must not be taken as denied.
     */
    private fun miuiOp(context: Context, op: Int): String =
        try {
            val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
            val method = AppOpsManager::class.java.getMethod(
                "checkOpNoThrow", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, String::class.java,
            )
            when (method.invoke(appOps, op, Process.myUid(), context.packageName) as Int) {
                AppOpsManager.MODE_ALLOWED -> "granted"
                AppOpsManager.MODE_IGNORED, AppOpsManager.MODE_ERRORED -> "denied"
                else -> "unknown"
            }
        } catch (e: Throwable) {
            "unknown"
        }

    fun hasRuntimeNotificationPermission(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private const val MIUI_SECURITY = "com.miui.securitycenter"
    private const val OP_AUTO_START = 10008
    private const val OP_SHOW_WHEN_LOCKED = 10020
    private const val OP_BACKGROUND_START_ACTIVITY = 10021
}
