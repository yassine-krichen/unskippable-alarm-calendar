package com.yassine.alarmcalendar.update

import java.net.URI
import java.net.URISyntaxException

/**
 * What the in-app updater may download and install, as pure functions (no Android classes, so the JVM tests cover
 * them). The plugin asks these before every network hop and before it hands a file to the system installer. The
 * allowlist lives here and nowhere else: if GitHub changes the host that serves release assets, this is the one place.
 */
object UpdateRules {
    /** The only repository an update may come from. */
    private const val RELEASE_PATH_PREFIX = "/yassine-krichen/unskippable-alarm-calendar/releases/download/"

    /** First hop: the release asset URL on github.com. */
    private const val FIRST_HOST = "github.com"

    /** Every later hop (GitHub answers an asset URL with a redirect to its storage host). */
    private val REDIRECT_HOSTS = setOf("github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com")

    /** The APK is about 5 MB today; this only stops a runaway or hostile response. */
    const val MAX_APK_BYTES = 150L * 1024 * 1024

    const val MAX_REDIRECTS = 5

    private val SHA256_PATTERN = Regex("^[0-9a-fA-F]{64}$")
    private val VERSION_PATTERN = Regex("^\\d{1,4}\\.\\d{1,2}\\.\\d{1,2}$")

    // <tag>/<file name>: plain characters only, so nothing in the path can walk out of the release.
    private val ASSET_PATH_PATTERN = Regex("^$RELEASE_PATH_PREFIX[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")

    /** The URL the app was told to download: https, github.com, this repository's release assets, nothing else. */
    fun isAllowedFirstUrl(url: String): Boolean {
        val uri = parse(url) ?: return false
        return isPlainHttps(uri) && uri.host?.lowercase() == FIRST_HOST && isAssetPath(uri.rawPath) &&
            uri.rawQuery == null && uri.rawFragment == null
    }

    /**
     * Any redirect target: https on one of GitHub's hosts, no credentials in the URL. A hop that stays on github.com
     * must still be a release asset of this repository (the same rule as the first URL), so a redirect cannot lead
     * to some other github.com page or repository. The storage hosts serve opaque signed paths and are not path-checked.
     */
    fun isAllowedRedirect(url: String): Boolean {
        val uri = parse(url) ?: return false
        if (!isPlainHttps(uri)) return false
        val host = uri.host?.lowercase() ?: return false
        if (host !in REDIRECT_HOSTS) return false
        return host != FIRST_HOST || isAssetPath(uri.rawPath)
    }

    /**
     * Below Android 9 the installed and the downloaded signer sets are compared directly. An archive that reports no
     * signer cannot be compared here (the system installer still refuses a foreign key), so that case passes.
     */
    fun legacySignersMatch(installed: Set<String>, archive: Set<String>): Boolean =
        archive.isEmpty() || installed.isEmpty() || archive == installed

    /** Resolves a `Location` header against the URL it answered (it may be relative). Null when it is not a URI. */
    fun resolveLocation(current: String, location: String): String? {
        val base = parse(current) ?: return null
        return try {
            base.resolve(location).toString()
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    /** True for a SHA-256 given as exactly 64 hex characters (any case). */
    fun isValidSha256(value: String): Boolean = SHA256_PATTERN.matches(value)

    /** Hex digests compare case-insensitively; an invalid expected value never matches. */
    fun hashesMatch(expected: String, actual: String): Boolean = isValidSha256(expected) && expected.equals(actual, ignoreCase = true)

    /** x.y.z only: the name goes into a file name, so nothing else may through. */
    fun isValidVersionName(value: String): Boolean = VERSION_PATTERN.matches(value)

    fun withinSizeLimit(bytes: Long): Boolean = bytes in 1..MAX_APK_BYTES

    /** An update must have a larger versionCode than what is installed (Android refuses a downgrade anyway). */
    fun isNewer(installedVersionCode: Long, candidateVersionCode: Long): Boolean = candidateVersionCode > installedVersionCode

    /** The file the plugin stores a download under, inside its own cache folder. */
    fun apkFileName(versionName: String): String = "alarm-calendar-$versionName.apk"

    private fun isAssetPath(rawPath: String?): Boolean {
        if (rawPath == null || !ASSET_PATH_PATTERN.matches(rawPath)) return false
        // A segment of dots only ("." / "..") would match the character class.
        return rawPath.split('/').none { segment -> segment.isNotEmpty() && segment.all { it == '.' } }
    }

    private fun isPlainHttps(uri: URI): Boolean =
        uri.scheme == "https" && uri.userInfo == null && (uri.port == -1 || uri.port == 443) && uri.host != null

    private fun parse(url: String): URI? =
        try {
            URI(url)
        } catch (e: URISyntaxException) {
            null
        }
}
