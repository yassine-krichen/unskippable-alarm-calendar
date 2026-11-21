package com.yassine.alarmcalendar.update

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.yassine.alarmcalendar.alarm.AlarmHost
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The app's own updater. The web side finds a newer GitHub release and passes the asset URL and its SHA-256; this
 * plugin downloads it (every hop checked by [UpdateRules]), checks the hash, package, signer and version, and hands it
 * to the system installer. The user always confirms in the system installer: nothing is ever installed silently.
 * Registered in MainActivity (a local plugin, not an npm package).
 *
 * The JavaScript side never names a file: a download lands under a name built from a validated version, in the app's
 * own cache folder, and install() finds it by that version again.
 */
@CapacitorPlugin(name = "AppUpdate")
class AppUpdatePlugin : Plugin() {
    private val downloading = AtomicBoolean(false)

    /**
     * Downloads `{ url, sha256, versionName }` and verifies it. Sends `updateProgress` `{ received, total }` while it
     * runs; `total` is 0 when the server did not say. Resolves `{ versionName, sizeBytes }` once the file is ready to
     * install. Rejects with a code: BAD_ARGUMENT, URL_REFUSED, BUSY, TOO_LARGE, NETWORK, HASH_MISMATCH, BAD_PACKAGE.
     */
    @PluginMethod
    fun download(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url is required", "BAD_ARGUMENT")
        val sha256 = call.getString("sha256") ?: return call.reject("sha256 is required", "BAD_ARGUMENT")
        val versionName = call.getString("versionName") ?: return call.reject("versionName is required", "BAD_ARGUMENT")
        if (!UpdateRules.isValidVersionName(versionName)) return call.reject("versionName is not x.y.z", "BAD_ARGUMENT")
        if (!UpdateRules.isValidSha256(sha256)) return call.reject("sha256 must be 64 hex characters", "BAD_ARGUMENT")
        if (!UpdateRules.isAllowedFirstUrl(url)) return call.reject("This download address is not allowed", "URL_REFUSED")
        if (!downloading.compareAndSet(false, true)) return call.reject("A download is already running", "BUSY")

        // The call is answered later, from another thread, so the bridge must keep it until then.
        bridge.saveCall(call)
        // Its own thread: plugin methods share one handler thread, and a download must not hold up the alarm calls.
        Thread {
            try {
                val file = downloadTo(url, sha256, versionName)
                call.resolve(JSObject().put("versionName", versionName).put("sizeBytes", file.length()))
            } catch (e: UpdateFailure) {
                AlarmHost.log("update.download_failed", mapOf("code" to e.code))
                call.reject(e.message, e.code)
            } catch (e: Exception) {
                AlarmHost.log("update.download_failed", mapOf("code" to "NETWORK", "error" to e.javaClass.simpleName))
                call.reject("The download failed", "NETWORK")
            } finally {
                downloading.set(false)
                bridge.releaseCall(call)
            }
        }.start()
    }

    /**
     * `{ versionName, sha256 }`: whether a verified copy of that update is still in the cache, for an app that was
     * killed after the download (for instance while the "install unknown apps" screen was open). The file is hashed
     * again against `sha256` (the release's digest) and run through the same package, signer and version checks as
     * a fresh download; a copy that fails either is deleted. Resolves `{ downloaded, sizeBytes }`, never rejects for
     * a missing or bad file.
     */
    @PluginMethod
    fun downloaded(call: PluginCall) {
        val versionName = call.getString("versionName") ?: return call.reject("versionName is required", "BAD_ARGUMENT")
        val sha256 = call.getString("sha256") ?: return call.reject("sha256 is required", "BAD_ARGUMENT")
        if (!UpdateRules.isValidVersionName(versionName)) return call.reject("versionName is not x.y.z", "BAD_ARGUMENT")
        if (!UpdateRules.isValidSha256(sha256)) return call.reject("sha256 must be 64 hex characters", "BAD_ARGUMENT")
        val none = JSObject().put("downloaded", false).put("sizeBytes", 0)
        val file = File(updatesDir(), UpdateRules.apkFileName(versionName))
        // A download in progress writes a .part file, never this one, so only a finished copy can be here.
        if (downloading.get() || !file.isFile) return call.resolve(none)
        try {
            if (!UpdateRules.hashesMatch(sha256, sha256Of(file))) throw UpdateFailure("HASH_MISMATCH", "The cached update does not match its checksum")
            checkPackage(file)
            call.resolve(JSObject().put("downloaded", true).put("sizeBytes", file.length()))
        } catch (e: Exception) {
            file.delete()
            call.resolve(none)
        }
    }

    /** `{ allowed }`: whether this app may ask the system installer to install packages (Android 8 and later). */
    @PluginMethod
    fun canInstall(call: PluginCall) {
        call.resolve(JSObject().put("allowed", canRequestInstalls()))
    }

    /** Opens the "install unknown apps" switch of this app. The JS side checks again when the app comes back. */
    @PluginMethod
    fun openInstallPermission(call: PluginCall) {
        val activity = activity ?: return call.reject("no activity")
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
        try {
            activity.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("The settings screen could not be opened")
        }
    }

    /**
     * Opens the system installer on the downloaded `{ versionName }`. Refuses while an alarm is ringing, snoozed or
     * waiting to ring again (the app restarts and a ringing alarm must not be cut off): ALARM_ACTIVE. Also
     * INSTALL_NOT_ALLOWED (the unknown-apps switch is off), NOT_DOWNLOADED and BAD_PACKAGE.
     */
    @PluginMethod
    fun install(call: PluginCall) {
        val versionName = call.getString("versionName") ?: return call.reject("versionName is required", "BAD_ARGUMENT")
        if (!UpdateRules.isValidVersionName(versionName)) return call.reject("versionName is not x.y.z", "BAD_ARGUMENT")
        if (AlarmHost.runtime(context).hasLiveAlarm()) {
            return call.reject("An alarm is ringing or snoozed. Finish it first.", "ALARM_ACTIVE")
        }
        if (!canRequestInstalls()) return call.reject("Installing is not allowed for this app yet", "INSTALL_NOT_ALLOWED")
        val file = File(updatesDir(), UpdateRules.apkFileName(versionName))
        if (!file.isFile) return call.reject("The update is not downloaded", "NOT_DOWNLOADED")
        val activity = activity ?: return call.reject("no activity")
        try {
            checkPackage(file)
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
            val intent = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(intent)
            AlarmHost.log("update.installer_opened", mapOf("versionName" to versionName))
            call.resolve(JSObject().put("started", true))
        } catch (e: UpdateFailure) {
            call.reject(e.message, e.code)
        } catch (e: Exception) {
            call.reject("The installer could not be opened", "INSTALLER")
        }
    }

    private class UpdateFailure(val code: String, message: String) : Exception(message)

    private fun updatesDir(): File = File(context.cacheDir, "updates").also { it.mkdirs() }

    private fun canRequestInstalls(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()

    private fun downloadTo(firstUrl: String, expectedSha256: String, versionName: String): File {
        val dir = updatesDir()
        // Only the update being downloaded is kept: an older or failed one is not worth its megabytes.
        dir.listFiles()?.forEach { it.delete() }
        val part = File(dir, "${UpdateRules.apkFileName(versionName)}.part")
        val target = File(dir, UpdateRules.apkFileName(versionName))
        var connection = open(firstUrl)
        try {
            var current = firstUrl
            var hops = 0
            // Redirects are followed by hand so that every hop is checked before a byte is requested from it.
            while (connection.responseCode in REDIRECT_CODES) {
                if (++hops > UpdateRules.MAX_REDIRECTS) throw UpdateFailure("URL_REFUSED", "Too many redirects")
                val location = connection.getHeaderField("Location") ?: throw UpdateFailure("NETWORK", "Redirect without a target")
                val next = UpdateRules.resolveLocation(current, location)
                if (next == null || !UpdateRules.isAllowedRedirect(next)) throw UpdateFailure("URL_REFUSED", "The download was redirected somewhere that is not allowed")
                connection.disconnect()
                current = next
                connection = open(next)
            }
            if (connection.responseCode != HttpURLConnection.HTTP_OK) throw UpdateFailure("NETWORK", "The server answered ${connection.responseCode}")
            val total = connection.contentLengthLong
            if (total > UpdateRules.MAX_APK_BYTES) throw UpdateFailure("TOO_LARGE", "The update is larger than expected")
            val digest = MessageDigest.getInstance("SHA-256")
            var received = 0L
            var lastReported = 0L
            connection.inputStream.use { input ->
                part.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        received += read
                        if (received > UpdateRules.MAX_APK_BYTES) throw UpdateFailure("TOO_LARGE", "The update is larger than expected")
                        digest.update(buffer, 0, read)
                        output.write(buffer, 0, read)
                        val now = System.currentTimeMillis()
                        if (now - lastReported >= PROGRESS_INTERVAL_MS) {
                            lastReported = now
                            notifyListeners("updateProgress", JSObject().put("received", received).put("total", maxOf(total, 0L)))
                        }
                    }
                }
            }
            notifyListeners("updateProgress", JSObject().put("received", received).put("total", received))
            if (!UpdateRules.withinSizeLimit(received)) throw UpdateFailure("NETWORK", "The download was empty")
            if (!UpdateRules.hashesMatch(expectedSha256, digest.digest().joinToString("") { "%02x".format(it) })) {
                throw UpdateFailure("HASH_MISMATCH", "The download does not match its checksum and was deleted")
            }
            if (!part.renameTo(target)) throw IOException("rename failed")
            checkPackage(target)
            return target
        } catch (e: Exception) {
            part.delete()
            target.delete()
            throw e
        } finally {
            connection.disconnect()
        }
    }

    private fun open(url: String): HttpURLConnection {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        connection.setRequestProperty("Accept", "application/octet-stream")
        connection.setRequestProperty("User-Agent", "AlarmCalendar-Updater")
        return connection
    }

    /**
     * The file must be this app (same package), signed by a key the installed app accepts, and newer. Android
     * enforces the signature and the downgrade itself; checking here turns its vague "App not installed" into a reason.
     */
    @Suppress("DEPRECATION")
    private fun checkPackage(file: File) {
        val pm = context.packageManager
        val signingFlag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val archive = pm.getPackageArchiveInfo(file.absolutePath, signingFlag) ?: throw UpdateFailure("BAD_PACKAGE", "The file is not an app package")
        if (archive.packageName != context.packageName) throw UpdateFailure("BAD_PACKAGE", "The file is a different app")
        val installed = pm.getPackageInfo(context.packageName, 0)
        if (!UpdateRules.isNewer(PackageInfoCompat.getLongVersionCode(installed), PackageInfoCompat.getLongVersionCode(archive))) {
            throw UpdateFailure("BAD_PACKAGE", "The downloaded version is not newer than the installed one")
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // The installed app accepts a signer that is its current key or one earlier in its key rotation lineage,
            // so a future key rotation does not make this check refuse a legitimate update.
            val archiveSigners = archive.signingInfo?.apkContentsSigners.orEmpty()
            val accepted = archiveSigners.all {
                pm.hasSigningCertificate(context.packageName, it.toByteArray(), PackageManager.CERT_INPUT_RAW_X509)
            }
            if (!accepted) throw UpdateFailure("BAD_PACKAGE", "The update is signed with a different key than the installed app")
        } else {
            val installedSigners = legacySigners(pm.getPackageInfo(context.packageName, signingFlag))
            if (!UpdateRules.legacySignersMatch(installedSigners, legacySigners(archive))) {
                throw UpdateFailure("BAD_PACKAGE", "The update is signed with a different key than the installed app")
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun legacySigners(info: android.content.pm.PackageInfo): Set<String> =
        info.signatures.orEmpty().map { it.toCharsString() }.toSet()

    private fun sha256Of(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private companion object {
        val REDIRECT_CODES = setOf(301, 302, 303, 307, 308)
        const val PROGRESS_INTERVAL_MS = 250L
    }
}
