# Releasing and updating

How a new version gets from this repository to the phone and the desktop. Everything is **local and by hand**: there is no
GitHub Actions workflow, no secret is stored on GitHub, and nothing here pushes, tags or publishes without the owner doing it.
Why it is built this way is in `docs/decisions.md` ("In-app updates from GitHub Releases").

## Install and update (for the owner)

- **Phone:** the first install is a release APK from the GitHub release page (or `task android:install:release` over USB). From
  then on the app tells you when a newer release exists: a banner above the calendar, and a dot on the Settings icon. Open it,
  Download, Install, confirm in the Android installer. Settings, About and updates shows the version and has "Check now".
- **Desktop:** the app tells you the same way. "Open release page" opens the releases page in the browser; download
  `Alarm-Calendar-Setup-<version>.exe` and run it. It is unsigned, so Windows SmartScreen warns once: More info, then Run anyway.
  The per-user install keeps your data in `%APPDATA%\Alarm Calendar`.
- The app looks automatically at most once per 24 hours (when it opens, when it comes back to the front), and after a failed look
  it waits at least an hour before trying again. "Check now" always looks, whatever happened before.

## One version, one source

The root `package.json` `"version"` is the source (first release: `0.2.0`). `app/package.json` and `electron/package.json` copy it
(electron-builder reads the electron one), the web build gets `__APP_VERSION__` from it, and `android/app/build.gradle` reads the
same file: `versionName` is the version, `versionCode = major*10000 + minor*100 + patch` (0.2.0 is 200, 0.2.1 is 201). Minor and
patch stay below 100, so a later version always has a larger code and Android accepts the update.

```
task version:bump -- patch        # or minor, major, or an explicit x.y.z
```

It needs a clean tree and rewrites the three files; commit that as its own change. `task release` refuses when the three disagree.

## The keystore (read this once)

Release APKs are signed with `C:/Users/user/.android-keys/alarm-calendar-release.jks`. Gradle reads four properties from
`%USERPROFILE%\.gradle\gradle.properties` (or environment variables of the same names, which keeps a future CI possible):

`ALARMCAL_STORE_FILE`, `ALARMCAL_STORE_PASSWORD`, `ALARMCAL_KEY_ALIAS`, `ALARMCAL_KEY_PASSWORD`.

- The values are never printed, logged or committed; `.gitignore` blocks `*.jks` and `*.keystore`. Without the four properties
  `assembleRelease` **fails with a message naming them** instead of building an unsigned APK. Debug builds do not need them.
- **Back it up:** the file and the passwords, in a password manager plus an offline copy. Never in the vault git repository, never
  in this repository. **If the keystore is lost, no installed phone can ever update again**: Android refuses an update signed with
  a different key, so every install would have to be uninstalled, which wipes the engine's local schedule and any completion not
  yet uploaded.

## Releasing a version

1. Make the change, commit it, bump the version (`task version:bump -- patch`), commit, **push** (the owner approves pushes).
2. `task release` (or `task alarm-calendar:release` from the personal root). It asks for confirmation, then:
   1. `release.mjs preflight`: the tree is clean, the three versions agree, the tag `v<version>` does not exist, HEAD is on the
      remote, and `VITE_ALARM_DEBUG` is not set (in the environment, or by name in any of `app/.env`, `.env.local`, `.env.android`,
      `.env.android.local` and the other `.env.*` files Vite reads; the files are never printed).
   2. `task test` (every workspace suite plus the script tests) and `task android:test` (Kotlin on the JVM).
   3. `task package` (the NSIS installer) and `task android:release` (web bundle, then the signed APK).
   4. `release.mjs verify`: the built web output holds no Supabase secret key, no `service_role` and no debug backend.
   5. `release.mjs assemble`: copies the outputs to `release/v<version>/` as `Alarm-Calendar-<version>.apk` and
      `Alarm-Calendar-Setup-<version>.exe`, and writes `SHA256SUMS.txt` (`sha256sum` format, lowercase hex).
   6. `release.mjs draft`: `gh release create v<version> --draft --generate-notes --target <HEAD>` with the three files.
3. The release is a **draft**: `releases/latest` does not see it, so no app is told about it yet. Read it on GitHub, then publish it
   yourself (this creates the tag): `gh release edit v<version> --draft=false`, or the Publish button. Creating the release and
   publishing it each need the owner's explicit go-ahead every time.

The app only ever uses the publishable Supabase key; the build reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from
`app/.env`. The release task never prints them.

If a step fails, fix it and run `task release` again; nothing before the draft changes GitHub. A draft you do not want:
`gh release delete v<version>` (or delete it in the web UI; a draft has no tag yet). A published release that turns out bad: publish a
higher version; never re-use a version number, because phones that already took it will not "update" to the same code.

## One-time switch from the debug build to the release build (the owner's phone)

The debug build and the release build share the app id `com.yassine.alarmcalendar` (no `applicationIdSuffix`, so two copies can never
both ring), but they are signed with different keys, so Android refuses to install one over the other. Once:

1. Open the debug app with the phone online, so pending Dones are uploaded.
2. `adb uninstall com.yassine.alarmcalendar`.
3. Install the release APK (`task android:install:release`, or the APK from the release page).
4. Sign in again.
5. Grant notifications, full-screen alarms and battery again, and the HyperOS autostart / lock screen / pop-up switches (the
   permission dialog guides you).

Your data is in Supabase and is unaffected; the engine's local schedule resets and is rebuilt on the first push. From then on
`task android:install` (the debug build) over a release install fails on the signature: uninstall first, or use
`task android:install:release`.

## How the phone updates itself

`AppUpdatePlugin` (Kotlin, no new dependency) downloads the release's APK from GitHub, then:

- the first URL must be `https://github.com/yassine-krichen/unskippable-alarm-calendar/releases/download/...`; every redirect hop
  must be https on `github.com`, `objects.githubusercontent.com` or `release-assets.githubusercontent.com` (one list, in
  `update/UpdateRules.kt`), a hop that stays on `github.com` must again be a release asset of this repository, at most 5 hops and
  150 MB;
- the SHA-256 must equal the asset's `digest` from the GitHub API; a mismatch deletes the file. A release whose APK has no digest is not
  downloaded by the app (it says so and points at the release page): there is no fallback, because a WebView cannot rely on fetching`n  `SHA256SUMS.txt` across GitHub's redirect. `SHA256SUMS.txt` stays on the release for people to check by hand;
- the file must be this app, with a higher versionCode, and signed by a key the installed app accepts (Android 9 and later asks the
  system with `hasSigningCertificate`, which also accepts a key from the app's rotation lineage; older versions compare the signers);
- Android's "install unknown apps" switch must be on for the app (the app opens that screen and carries on when you return; HyperOS
  may add a security scan or an account prompt of its own);
- the install is refused while an alarm is ringing, snoozed or waiting to ring again. That is a snapshot taken when you press Install:
  an alarm can start while the system installer is open, and finishing the install then restarts the app and cuts that ring. It is not
  lost (the engine state is on disk and `BootReceiver` on `MY_PACKAGE_REPLACED` rebuilds it, so the alarm rings again), but do not
  install within a couple of minutes of an alarm;
- if the app is killed after the download (for instance while the unknown-apps screen is open), it finds the cached file on the next
  launch, hashes it again against the release digest, re-runs the package and signer checks and shows Install again without
  downloading twice;
- the system installer always asks you to confirm. After the update `BootReceiver` (`MY_PACKAGE_REPLACED`) reschedules the next alarm.

## Gotchas

- **Any Gradle release build needs the signing properties**, not only `task release`: `gradlew assembleRelease` (also `bundleRelease` and
  `packageRelease`) fails without the four `ALARMCAL_*` values, by design. `gradlew assembleDebug` and the unit tests do not.
- **Release from the main checkout, not from a worktree.** The NSIS step fails when the path to `node_modules` is longer than 260
  characters (a Claude worktree under `.claude/worktrees/` is), and a worktree has no `app/.env` (it is gitignored), so the build would
  have no Supabase URL. Run `task release` in the normal clone, on the pushed commit.

## Not done on purpose

- A GitHub Actions release workflow. If it is wanted later, it needs the secrets `ANDROID_KEYSTORE_BASE64`,
  `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, the variables `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_PUBLISHABLE_KEY`, actions pinned by SHA, `contents: write` on the release job only, and `bash ./gradlew` (the wrapper
  was committed from Windows and may lack the executable bit). The Gradle signing already falls back to environment variables.
- `electron-updater` and a signed Windows installer. The desktop only says a new version exists and opens the release page.
