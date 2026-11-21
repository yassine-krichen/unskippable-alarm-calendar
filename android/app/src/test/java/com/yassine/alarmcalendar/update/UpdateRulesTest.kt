package com.yassine.alarmcalendar.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateRulesTest {
    private val goodAsset =
        "https://github.com/yassine-krichen/unskippable-alarm-calendar/releases/download/v0.2.1/Alarm-Calendar-0.2.1.apk"

    @Test
    fun acceptsTheReleaseAssetOfThisRepository() {
        assertTrue(UpdateRules.isAllowedFirstUrl(goodAsset))
        assertTrue(UpdateRules.isAllowedFirstUrl(goodAsset.replace("https://github.com", "https://GitHub.com")))
        assertTrue(UpdateRules.isAllowedFirstUrl(goodAsset.replace("github.com", "github.com:443")))
    }

    @Test
    fun refusesAnyOtherFirstUrl() {
        // plain http, another host, another repository, another path of this repository
        assertFalse(UpdateRules.isAllowedFirstUrl(goodAsset.replace("https:", "http:")))
        assertFalse(UpdateRules.isAllowedFirstUrl(goodAsset.replace("github.com", "evil.example")))
        assertFalse(UpdateRules.isAllowedFirstUrl(goodAsset.replace("yassine-krichen", "someone-else")))
        assertFalse(UpdateRules.isAllowedFirstUrl("https://github.com/yassine-krichen/unskippable-alarm-calendar/archive/v0.2.1.zip"))
        assertFalse(UpdateRules.isAllowedFirstUrl("https://github.com/yassine-krichen/unskippable-alarm-calendar/releases/latest"))
        // the storage host is only valid as a redirect target, never as the URL the app is given
        assertFalse(UpdateRules.isAllowedFirstUrl("https://objects.githubusercontent.com/yassine-krichen/unskippable-alarm-calendar/releases/download/v1/a.apk"))
    }

    @Test
    fun refusesTricksInTheFirstUrl() {
        // credentials that make the real host look like a user name, a port, dot segments, an encoded path, junk
        assertFalse(UpdateRules.isAllowedFirstUrl("https://github.com@evil.example/yassine-krichen/unskippable-alarm-calendar/releases/download/v1/a.apk"))
        assertFalse(UpdateRules.isAllowedFirstUrl(goodAsset.replace("github.com", "github.com:8443")))
        assertFalse(UpdateRules.isAllowedFirstUrl(goodAsset.replace("v0.2.1/Alarm-Calendar-0.2.1.apk", "../../../../evil/a.apk")))
        assertFalse(UpdateRules.isAllowedFirstUrl(goodAsset.replace("v0.2.1/Alarm-Calendar-0.2.1.apk", "%2e%2e/a.apk")))
        assertFalse(UpdateRules.isAllowedFirstUrl(goodAsset.replace("v0.2.1/Alarm-Calendar-0.2.1.apk", "v1/a.apk?x=1")))
        assertFalse(UpdateRules.isAllowedFirstUrl("https://github.com.evil.example/yassine-krichen/unskippable-alarm-calendar/releases/download/v1/a.apk"))
        assertFalse(UpdateRules.isAllowedFirstUrl("not a url"))
        assertFalse(UpdateRules.isAllowedFirstUrl(""))
    }

    @Test
    fun everyRedirectHopMustBeHttpsOnGitHub() {
        assertTrue(UpdateRules.isAllowedRedirect("https://objects.githubusercontent.com/github-production-release-asset/abc?X-Amz-Signature=s"))
        assertTrue(UpdateRules.isAllowedRedirect("https://release-assets.githubusercontent.com/github-production-release-asset/abc?sp=r"))
        assertTrue(UpdateRules.isAllowedRedirect("https://github.com/yassine-krichen/unskippable-alarm-calendar/releases/download/v1/a.apk"))

        assertFalse(UpdateRules.isAllowedRedirect("http://objects.githubusercontent.com/a"))
        assertFalse(UpdateRules.isAllowedRedirect("https://evil.example/a"))
        assertFalse(UpdateRules.isAllowedRedirect("https://objects.githubusercontent.com.evil.example/a"))
        assertFalse(UpdateRules.isAllowedRedirect("https://evilgithubusercontent.com/a"))
        assertFalse(UpdateRules.isAllowedRedirect("https://user:pw@objects.githubusercontent.com/a"))
        assertFalse(UpdateRules.isAllowedRedirect("https://objects.githubusercontent.com:8443/a"))
        assertFalse(UpdateRules.isAllowedRedirect("ftp://github.com/a"))
        assertFalse(UpdateRules.isAllowedRedirect("javascript:alert(1)"))
    }

    @Test
    fun aHopThatStaysOnGitHubMustBeAnAssetOfThisRepository() {
        assertFalse(UpdateRules.isAllowedRedirect("https://github.com/"))
        assertFalse(UpdateRules.isAllowedRedirect("https://github.com/someone/else/releases/download/v1/a.apk"))
        assertFalse(UpdateRules.isAllowedRedirect("https://github.com/yassine-krichen/unskippable-alarm-calendar/archive/v1.zip"))
        assertFalse(UpdateRules.isAllowedRedirect("https://github.com/yassine-krichen/unskippable-alarm-calendar/releases/download/../../x/a.apk"))
        assertTrue(UpdateRules.isAllowedRedirect("https://github.com/yassine-krichen/unskippable-alarm-calendar/releases/download/v1/a.apk"))
    }

    @Test
    fun legacySignersMustMatchUnlessOneSideReportsNone() {
        assertTrue(UpdateRules.legacySignersMatch(setOf("a"), setOf("a")))
        assertFalse(UpdateRules.legacySignersMatch(setOf("a"), setOf("b")))
        assertFalse(UpdateRules.legacySignersMatch(setOf("a"), setOf("a", "b")))
        assertTrue(UpdateRules.legacySignersMatch(setOf("a"), emptySet()))
        assertTrue(UpdateRules.legacySignersMatch(emptySet(), setOf("a")))
    }

    @Test
    fun aRedirectChainIsValidatedHopByHop() {
        // GitHub answers the asset URL with a redirect to its storage; a later hop that leaves GitHub is refused.
        val hop1 = UpdateRules.resolveLocation(goodAsset, "https://release-assets.githubusercontent.com/x?sig=1")
        assertEquals("https://release-assets.githubusercontent.com/x?sig=1", hop1)
        assertTrue(UpdateRules.isAllowedRedirect(hop1!!))
        val hop2 = UpdateRules.resolveLocation(hop1, "https://evil.example/payload.apk")
        assertFalse(UpdateRules.isAllowedRedirect(hop2!!))
        // a downgrade to http is caught too
        assertFalse(UpdateRules.isAllowedRedirect(UpdateRules.resolveLocation(hop1, "http://github.com/a")!!))
    }

    @Test
    fun relativeLocationsResolveAgainstTheCurrentUrlAndStayOnItsHost() {
        assertEquals(
            "https://github.com/other/path",
            UpdateRules.resolveLocation("https://github.com/a/b", "/other/path"),
        )
        assertNull(UpdateRules.resolveLocation("https://github.com/a", "http://[bad"))
    }

    @Test
    fun theSizeCapStopsEmptyAndHugeDownloads() {
        assertTrue(UpdateRules.withinSizeLimit(5L * 1024 * 1024))
        assertTrue(UpdateRules.withinSizeLimit(UpdateRules.MAX_APK_BYTES))
        assertFalse(UpdateRules.withinSizeLimit(UpdateRules.MAX_APK_BYTES + 1))
        assertFalse(UpdateRules.withinSizeLimit(0))
        assertFalse(UpdateRules.withinSizeLimit(-1))
    }

    @Test
    fun theExpectedHashMustBe64HexCharactersAndComparesCaseInsensitively() {
        val lower = "ab".repeat(32)
        assertTrue(UpdateRules.isValidSha256(lower))
        assertTrue(UpdateRules.isValidSha256(lower.uppercase()))
        assertFalse(UpdateRules.isValidSha256("ab".repeat(31)))
        assertFalse(UpdateRules.isValidSha256("zz".repeat(32)))
        assertFalse(UpdateRules.isValidSha256("sha256:$lower"))
        assertFalse(UpdateRules.isValidSha256(""))

        assertTrue(UpdateRules.hashesMatch(lower, lower.uppercase()))
        assertFalse(UpdateRules.hashesMatch(lower, "cd".repeat(32)))
        // an invalid expected value never "matches", not even itself
        assertFalse(UpdateRules.hashesMatch("", ""))
        assertFalse(UpdateRules.hashesMatch("nothex", "nothex"))
    }

    @Test
    fun onlyAHigherVersionCodeIsAnUpdate() {
        assertTrue(UpdateRules.isNewer(200, 201))
        assertTrue(UpdateRules.isNewer(200, 10000))
        assertFalse(UpdateRules.isNewer(200, 200))
        assertFalse(UpdateRules.isNewer(200, 100))
    }

    @Test
    fun theVersionNameIsSafeForAFileName() {
        assertTrue(UpdateRules.isValidVersionName("0.2.1"))
        assertFalse(UpdateRules.isValidVersionName("../0.2.1"))
        assertFalse(UpdateRules.isValidVersionName("0.2.1/../../x"))
        assertFalse(UpdateRules.isValidVersionName("v0.2.1"))
        assertFalse(UpdateRules.isValidVersionName("0.2"))
        assertEquals("alarm-calendar-0.2.1.apk", UpdateRules.apkFileName("0.2.1"))
    }
}
