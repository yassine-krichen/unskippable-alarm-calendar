package com.yassine.alarmcalendar.alarm

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.content.res.ColorStateList
import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.window.OnBackInvokedDispatcher
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.yassine.alarmcalendar.engine.AlarmView

/**
 * The alarm screen: native, not the WebView, so it can show over the lock screen and turn the screen on. Black
 * and white with big type and large rounded buttons, mirroring the app's b0 preset (a native view cannot use
 * shadcn). It shows the oldest ringing alarm in the engine; Done and Snooze are the only way out.
 *
 * Back is disabled. If the screen is destroyed without a choice (swiped away, killed by the system) the alarm
 * rings again after the refire delay (spec 6.5); Home and the power button only hide it, and the sound, which
 * belongs to [AlarmService], keeps going until Done or Snooze.
 */
class AlarmActivity : Activity() {
    private lateinit var content: LinearLayout
    private var displayed: String? = null
    private var answered = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        current = this
        showOverLockScreen()
        swallowBack()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(24), dp(24), dp(24))
        }
        val root = ScrollView(this).apply {
            setBackgroundColor(Color.BLACK)
            isFillViewport = true
            addView(content, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        setContentView(root)
        render()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        render()
    }

    override fun onStart() {
        super.onStart()
        visible = true
    }

    override fun onStop() {
        visible = false
        super.onStop()
    }

    override fun onDestroy() {
        if (current === this) current = null
        visible = false
        val id = displayed
        if (id != null && !answered && !isChangingConfigurations) {
            AlarmHost.log("activity.closed_without_choice", mapOf("occurrenceId" to id))
            AlarmController.windowClosed(applicationContext, id)
        }
        super.onDestroy()
    }

    // The screen cannot be left with Back; the only exits are the two buttons. Android 13+ delivers Back to a
    // registered callback (and, for apps targeting 36, no longer calls onBackPressed); before that onBackPressed is it.
    @SuppressLint("GestureBackNavigation")
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onBackPressed() = Unit

    private fun swallowBack() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { }
        }
    }

    /** Called by the service when what is ringing changed. */
    fun refresh() {
        runOnUiThread { render() }
    }

    @Suppress("DEPRECATION")
    private fun showOverLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                    WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD,
            )
        }
    }

    private fun render() {
        val active = AlarmHost.runtime(this).activeRinging()
        val front = active.firstOrNull()
        if (front == null) {
            // Nothing rings any more (answered elsewhere, the event was deleted, or this was a stale launch).
            displayed = null
            finishAndRemoveTask()
            return
        }
        if (front.occurrenceId != displayed) {
            displayed = front.occurrenceId
            answered = false
        }
        val timeZone = AlarmHost.runtime(this).settings()?.timezone ?: "UTC"
        content.removeAllViews()
        build(front, active.size - 1, timeZone)
    }

    private fun build(view: AlarmView, others: Int, timeZone: String) {
        content.addView(label(if (view.kind == "pre_prayer" || view.kind == "prayer") "PRAYER" else "ALARM", 13f, 0x99FFFFFF.toInt(), Typeface.DEFAULT_BOLD, letterSpacing = 0.18f))
        content.addView(
            label(TimeText.time(this, view.occurrenceAtMs, timeZone), 84f, Color.WHITE, Typeface.create("sans-serif-light", Typeface.NORMAL)),
            margins(top = 8),
        )
        content.addView(label(TimeText.date(view.occurrenceAtMs, timeZone), 18f, 0x99FFFFFF.toInt(), Typeface.DEFAULT))
        content.addView(
            label(view.title, 32f, Color.WHITE, Typeface.DEFAULT_BOLD).apply { maxLines = 5 },
            margins(top = 40),
        )
        val notes = view.notes?.takeIf { it.isNotBlank() }
        if (notes != null) {
            content.addView(label(notes, 18f, 0xB3FFFFFF.toInt(), Typeface.DEFAULT), margins(top = 16))
        }
        if (others > 0) {
            content.addView(label("+$others more ringing", 15f, 0x99FFFFFF.toInt(), Typeface.DEFAULT), margins(top = 16))
        }
        // Pushes the buttons to the bottom while keeping everything reachable on a small screen.
        content.addView(View(this), LinearLayout.LayoutParams(0, 0, 1f))

        view.snoozeNotice?.let {
            content.addView(
                label(it, 16f, Color.WHITE, Typeface.DEFAULT_BOLD).apply { gravity = Gravity.CENTER },
                margins(top = 24, bottom = 12),
            )
        }
        val doneText = if (view.kind == "prayer") "Prayed" else "Done"
        content.addView(button(doneText, 72, Color.WHITE, Color.BLACK, null) { answer(view) { AlarmController.done(this, it) } }, margins(top = 16))
        view.snoozeLabel?.let { snooze ->
            content.addView(button(snooze, 64, 0xFF1A1A1A.toInt(), Color.WHITE, 0xFF3A3A3A.toInt()) { answer(view) { AlarmController.snooze(this, it) } }, margins(top = 12))
        }
    }

    private fun answer(view: AlarmView, action: (String) -> Unit) {
        if (answered && displayed == view.occurrenceId) return
        answered = true
        action(view.occurrenceId)
        // The engine now says what is next; refresh() from the service may also arrive, which is harmless.
        render()
    }

    private fun label(text: String, sizeSp: Float, color: Int, typeface: Typeface, letterSpacing: Float = 0f): TextView =
        TextView(this).apply {
            this.text = text
            setTextColor(color)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
            this.typeface = typeface
            this.letterSpacing = letterSpacing
            includeFontPadding = false
        }

    private fun button(text: String, heightDp: Int, fill: Int, textColor: Int, stroke: Int?, onClick: () -> Unit): Button =
        Button(this).apply {
            this.text = text
            isAllCaps = false
            setTextColor(textColor)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            val shape = GradientDrawable().apply {
                setColor(fill)
                cornerRadius = dp(20).toFloat()
                if (stroke != null) setStroke(dp(1), stroke)
            }
            background = RippleDrawable(ColorStateList.valueOf(0x33808080), shape, null)
            stateListAnimator = null
            minHeight = dp(heightDp)
            minimumHeight = dp(heightDp)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(heightDp))
            setOnClickListener { onClick() }
        }

    private fun margins(top: Int = 0, bottom: Int = 0): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(top)
            bottomMargin = dp(bottom)
        }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        /** The oldest alarm that rings is the one shown; this id-less intent just brings the screen up. */
        fun intent(context: Context): Intent =
            Intent(context, AlarmActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

        @Volatile
        var current: AlarmActivity? = null

        /** Between onStart and onStop: the screen is in front of the user. */
        @Volatile
        var visible: Boolean = false
    }
}
