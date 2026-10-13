package com.yassine.alarmcalendar.alarm

import android.app.Notification
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.app.NotificationCompat
import com.yassine.alarmcalendar.R
import com.yassine.alarmcalendar.engine.AlarmView

/**
 * Foreground service that owns the sound while an alarm is ringing: a looping bundled sound on the alarm stream,
 * a vibration pattern, a partial wake lock, and the high-importance notification whose full-screen intent opens
 * [AlarmActivity] over the lock screen. It holds no alarm logic of its own: on every sync it asks the engine which
 * alarms are ringing and shows the oldest, and stops itself when there are none.
 *
 * Foreground service type: `systemExempted`, the type the platform provides for apps holding SCHEDULE_EXACT_ALARM
 * or USE_EXACT_ALARM (this app holds USE_EXACT_ALARM as an alarm clock). It has no timeout and no
 * BOOT_COMPLETED restriction, unlike `mediaPlayback`, which Android 15 forbids starting from a boot receiver. If the
 * platform ever refuses it, `mediaPlayback` (also declared) is the fallback so the alarm still rings.
 */
class AlarmService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private var player: MediaPlayer? = null
    private var playingFor: String? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var focusRequest: AudioFocusRequest? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        Notifications.ensureChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // The notification must be up within seconds of startForegroundService, so it comes before anything else.
        val active = AlarmHost.runtime(this).activeRinging()
        if (!enterForeground(notificationFor(active))) {
            // Neither foreground type was accepted: give up this start and try again shortly rather than ring with no
            // foreground protection or crash. The engine still has the alarm due, so the retry rings it.
            AlarmHost.log("service.foreground_failed")
            if (instance === this) instance = null
            AlarmController.scheduleRetry(this)
            stopSelf()
            return START_NOT_STICKY
        }
        sync()
        // START_STICKY: if the process is killed while ringing, the system restarts the service (with a null
        // intent) and the engine, which persisted the ringing state, rings again.
        return START_STICKY
    }

    /** Asks the service to re-read the engine on the main thread; safe from any thread. */
    fun requestSync() {
        main.post { sync() }
    }

    private fun sync() {
        val runtime = AlarmHost.runtime(this)
        val active = runtime.activeRinging()
        if (active.isEmpty()) {
            AlarmHost.log("service.idle")
            if (instance === this) instance = null
            main.removeCallbacks(ticker)
            stopRinging()
            stopForeground(STOP_FOREGROUND_REMOVE)
            AlarmActivity.current?.refresh()
            stopSelf()
            return
        }
        val front = active.first()
        getSystemService(NotificationManager::class.java).notify(Notifications.ID_RINGING, notificationFor(active))
        if (playingFor != front.occurrenceId) startRinging(front)
        holdWakeLock()
        AlarmActivity.current?.refresh()
        if (!AlarmActivity.visible) launchActivity()
        main.removeCallbacks(ticker)
        main.postDelayed(ticker, KEEP_REACHABLE_MS)
    }

    /**
     * While anything rings, every half minute: put the notification back (a user can swipe it away, and the delete
     * intent only covers a swipe while this process lives), renew the wake lock, and try to bring the alarm screen up
     * again if it is not in front. A ringing alarm must always be reachable, and this is also what keeps trying when
     * notifications are denied (the activity launch attempt works where the phone allows it).
     */
    private val ticker = object : Runnable {
        override fun run() {
            val active = AlarmHost.runtime(this@AlarmService).activeRinging()
            if (active.isEmpty()) return
            AlarmHost.log("service.keep_reachable", mapOf("screenVisible" to AlarmActivity.visible))
            getSystemService(NotificationManager::class.java).notify(Notifications.ID_RINGING, notificationFor(active))
            holdWakeLock()
            if (!AlarmActivity.visible) launchActivity()
            main.postDelayed(this, KEEP_REACHABLE_MS)
        }
    }

    private fun notificationFor(active: List<AlarmView>): Notification {
        val timeZone = AlarmHost.runtime(this).settings()?.timezone ?: "UTC"
        val front = active.firstOrNull()
            ?: return NotificationCompat.Builder(this, Notifications.CHANNEL_RINGING)
                .setSmallIcon(R.drawable.ic_alarm_notification).setContentTitle("Alarm").build()
        return Notifications.ringing(this, front, active.size - 1, timeZone)
    }

    /** True once the service is in the foreground. */
    private fun enterForeground(notification: Notification): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Before Android 14 the manifest types apply as they are; there is no per-call check to satisfy.
            return tryStartForeground { startForeground(Notifications.ID_RINGING, notification) }
        }
        val exempted = tryStartForeground {
            startForeground(Notifications.ID_RINGING, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED)
        }
        if (exempted) return true
        AlarmHost.log("service.type_refused", mapOf("type" to "systemExempted"))
        return tryStartForeground {
            startForeground(Notifications.ID_RINGING, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        }
    }

    private fun tryStartForeground(start: () -> Unit): Boolean =
        try {
            start()
            true
        } catch (e: Exception) {
            AlarmHost.log("service.start_foreground_failed", mapOf("error" to e.javaClass.simpleName))
            false
        }

    private fun launchActivity() {
        try {
            // Allowed from here when the app was granted background pop-ups (HyperOS) or the device is locked
            // (the full-screen intent of the notification does the same); otherwise the system blocks it silently.
            startActivity(AlarmActivity.intent(this))
        } catch (e: Exception) {
            AlarmHost.log("service.activity_launch_failed", mapOf("error" to e.javaClass.simpleName))
        }
    }

    private fun startRinging(front: AlarmView) {
        stopSound()
        playingFor = front.occurrenceId
        requestAudioFocus()
        player = createPlayer(front.soundId)
        vibrate()
        AlarmHost.log("service.ringing", mapOf("occurrenceId" to front.occurrenceId, "sound" to front.soundId))
    }

    private fun createPlayer(soundId: String?): MediaPlayer? {
        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        val name = if (soundId != null && soundId in BUNDLED_SOUNDS) soundId else DEFAULT_SOUND
        // The bundled sounds are the web app's own files (app/public/sounds), copied into the assets by `cap sync`.
        val fromAssets = try {
            val afd = assets.openFd("public/sounds/$name.wav")
            MediaPlayer().apply {
                setAudioAttributes(attributes)
                // Keeps the CPU on while the player runs, on top of the service's own lock.
                setWakeMode(this@AlarmService, PowerManager.PARTIAL_WAKE_LOCK)
                setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
                afd.close()
                isLooping = true
                prepare()
                start()
            }
        } catch (e: Exception) {
            AlarmHost.log("sound.asset_failed", mapOf("sound" to name, "error" to e.javaClass.simpleName))
            null
        }
        if (fromAssets != null) return fromAssets
        // The alarm must make noise even without the bundled files (no web build was synced): the system alarm tone.
        return try {
            MediaPlayer().apply {
                setAudioAttributes(attributes)
                setWakeMode(this@AlarmService, PowerManager.PARTIAL_WAKE_LOCK)
                setDataSource(this@AlarmService, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM))
                isLooping = true
                prepare()
                start()
            }
        } catch (e: Exception) {
            AlarmHost.log("sound.fallback_failed", mapOf("error" to e.javaClass.simpleName))
            null
        }
    }

    @Suppress("DEPRECATION")
    private fun vibrate() {
        val vibrator = getSystemService(Vibrator::class.java) ?: return
        if (!vibrator.hasVibrator()) return
        val alarmAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(VibrationEffect.createWaveform(VIBRATION_PATTERN, 0), alarmAttributes)
        } else {
            vibrator.vibrate(VIBRATION_PATTERN, 0, alarmAttributes)
        }
    }

    private fun requestAudioFocus() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build())
            .build()
        getSystemService(AudioManager::class.java).requestAudioFocus(request)
        focusRequest = request
    }

    private fun holdWakeLock() {
        val lock = wakeLock ?: getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "alarmcalendar:ringing")
            .apply { setReferenceCounted(false) }
            .also { wakeLock = it }
        // A timeout is the safety net; every sync renews it for as long as something rings.
        lock.acquire(WAKE_LOCK_MS)
    }

    private fun stopSound() {
        player?.let {
            try {
                it.stop()
            } catch (_: IllegalStateException) {
                // Already stopped or never started.
            }
            it.release()
        }
        player = null
        playingFor = null
        getSystemService(Vibrator::class.java)?.cancel()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { getSystemService(AudioManager::class.java).abandonAudioFocusRequest(it) }
        }
        focusRequest = null
    }

    private fun stopRinging() {
        stopSound()
        wakeLock?.let { if (it.isHeld) it.release() }
    }

    override fun onDestroy() {
        main.removeCallbacks(ticker)
        if (instance === this) instance = null
        stopRinging()
        super.onDestroy()
    }

    companion object {
        const val ACTION_SYNC = "com.yassine.alarmcalendar.action.SYNC"
        private val BUNDLED_SOUNDS = setOf("bell", "chime", "pulse")
        private const val DEFAULT_SOUND = "bell"
        private const val WAKE_LOCK_MS = 10 * 60_000L
        private const val KEEP_REACHABLE_MS = 30_000L
        private val VIBRATION_PATTERN = longArrayOf(0, 700, 500)

        /** The running service, if any. Same process as everything else, so a direct reference is safe. */
        @Volatile
        var instance: AlarmService? = null
    }
}
