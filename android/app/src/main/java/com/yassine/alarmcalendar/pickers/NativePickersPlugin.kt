package com.yassine.alarmcalendar.pickers

import android.app.DatePickerDialog
import android.app.Dialog
import android.app.TimePickerDialog
import android.text.format.DateFormat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.yassine.alarmcalendar.alarm.AlarmHost
import java.util.Calendar
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * The platform time and date dialogs (android.app.TimePickerDialog / DatePickerDialog), so the phone's own pickers
 * (12 or 24 hour as the phone is set, its calendar, its look) replace the web controls on Android. A local plugin
 * registered in MainActivity, not an npm package, and no new dependency: both dialogs ship with Android.
 *
 * Wall-clock strings only ('HH:mm', 'yyyy-MM-dd', see [PickerValues]); no time zone math happens here. Both methods
 * answer `{ value }` or `{ cancelled: true }`. The system Back button dismisses a dialog itself, so the web layer
 * never sees that press.
 */
@CapacitorPlugin(name = "NativePickers")
class NativePickersPlugin : Plugin() {
    /**
     * `{ value: 'HH:mm', dark?: boolean }`. The dialog follows the 12 / 24 hour setting of the phone. [dark] is the
     * app's own theme (it is a separate setting from the phone's), so the dialog matches the screen behind it.
     */
    @PluginMethod
    fun pickTime(call: PluginCall) {
        val time = PickerValues.parseTime(call.getString("value"))
            ?: return call.reject("value must be HH:mm", "BAD_ARGUMENT")
        val theme = dialogTheme(call.getBoolean("dark", false) ?: false)
        runDialog(call) { answer ->
            TimePickerDialog(
                activity,
                theme,
                { _, hour, minute -> answer(PickerValues.formatTime(hour, minute)) },
                time.hour,
                time.minute,
                DateFormat.is24HourFormat(activity)
            )
        }
    }

    /**
     * `{ value: 'yyyy-MM-dd', min?: 'yyyy-MM-dd', max?: 'yyyy-MM-dd', dark?: boolean }`. Min and max are inclusive
     * and optional; a bound that is not a real date is refused rather than ignored.
     */
    @PluginMethod
    fun pickDate(call: PluginCall) {
        val date = PickerValues.parseDate(call.getString("value"))
            ?: return call.reject("value must be yyyy-MM-dd", "BAD_ARGUMENT")
        val min = call.getString("min")?.let { PickerValues.parseDate(it) ?: return call.reject("min must be yyyy-MM-dd", "BAD_ARGUMENT") }
        val max = call.getString("max")?.let { PickerValues.parseDate(it) ?: return call.reject("max must be yyyy-MM-dd", "BAD_ARGUMENT") }
        val theme = dialogTheme(call.getBoolean("dark", false) ?: false)
        runDialog(call) { answer ->
            DatePickerDialog(
                activity,
                theme,
                // The dialog counts months from 0, the string from 1.
                { _, year, month, day -> answer(PickerValues.formatDate(year, month + 1, day)) },
                date.year,
                date.month - 1,
                date.day
            ).also { dialog ->
                if (min != null) dialog.datePicker.minDate = startOfDayMillis(min)
                if (max != null) dialog.datePicker.maxDate = startOfDayMillis(max)
            }
        }
    }

    /** The call and dialog being shown; null when none is. One at a time: a second request is refused, not stacked. */
    private class Open(val call: PluginCall) {
        val answered = AtomicBoolean(false)
        @Volatile var dialog: Dialog? = null
    }

    private val open = AtomicReference<Open?>(null)

    /**
     * Shows the dialog on the UI thread and answers the call exactly once: with the picked value, or
     * `cancelled` when it is dismissed any other way (outside tap, Back, Cancel). The OK listener runs before the dismiss
     * listener, so the `answered` flag keeps a pick from being answered twice. A failure while building or showing
     * the dialog rejects the call instead of leaving it hanging, and the screen being destroyed with a dialog open
     * rejects it too (see [handleOnDestroy]).
     */
    private fun runDialog(call: PluginCall, build: ((String) -> Unit) -> Dialog) {
        val current = Open(call)
        if (!open.compareAndSet(null, current)) return call.reject("A picker is already open", "BUSY")
        // The answer comes later, from the UI thread, so the bridge must keep the call until then.
        bridge.saveCall(call)

        val finish: (() -> Unit) -> Unit = { settle ->
            if (current.answered.compareAndSet(false, true)) {
                settle()
                bridge.releaseCall(call)
            }
            open.compareAndSet(current, null)
        }
        val answer: (String) -> Unit = { value -> finish { call.resolve(JSObject().put("value", value)) } }

        activity.runOnUiThread {
            try {
                if (activity.isFinishing || activity.isDestroyed) {
                    finish { call.reject("The screen is closing", "NO_ACTIVITY") }
                    return@runOnUiThread
                }
                val dialog = build(answer)
                current.dialog = dialog
                dialog.setOnDismissListener { finish { call.resolve(JSObject().put("cancelled", true)) } }
                dialog.show()
            } catch (e: Exception) {
                AlarmHost.log("picker.failed", mapOf("error" to e.javaClass.simpleName))
                finish { call.reject("The picker could not be shown", "PICKER_FAILED") }
            }
        }
    }

    /** The screen goes away with a dialog open (the activity is destroyed): close it and reject, never leave the call hanging. */
    override fun handleOnDestroy() {
        open.get()?.let { current ->
            if (current.answered.compareAndSet(false, true)) {
                current.call.reject("The screen was closed", "NO_ACTIVITY")
                bridge.releaseCall(current.call)
            }
            current.dialog?.let { if (it.isShowing) it.dismiss() }
            open.compareAndSet(current, null)
        }
        super.handleOnDestroy()
    }

    // The platform's own dialog themes: no AppCompat or Material dependency, and a dark / light choice the web layer controls.
    private fun dialogTheme(dark: Boolean): Int =
        if (dark) android.R.style.Theme_DeviceDefault_Dialog_Alert else android.R.style.Theme_DeviceDefault_Light_Dialog_Alert

    private fun startOfDayMillis(date: PickerValues.Date): Long =
        Calendar.getInstance().apply {
            clear()
            set(date.year, date.month - 1, date.day, 0, 0, 0)
        }.timeInMillis
}
