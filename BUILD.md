# Route Spoofer — Build & Setup

Route Spoofer is a standalone Android app that injects a scripted, **moving mock
GPS location** into the whole device. You drop waypoints on a map, set a speed,
emit interval and loop mode, hit Play — and every *other* app on the phone
(Google Maps, a driver app, anything reading device location) sees the phone
"driving" your route.

The playback clock and the OS mock-location injection live in a native Kotlin
**foreground service** (`MockLocationService`) so injection keeps running while
the app is in the background. The web UI is preview + control only.

There are two ways to get an installable APK. **You do not need a local Android
SDK for the cloud path.**

---

## 1. Cloud build (recommended — zero local Android SDK)

A GitHub Actions workflow (`.github/workflows/android.yml`) builds the APK on
every push and on manual dispatch. It signs with the fixed development key in
`android/ci/` (or a release keystore from secrets, if configured), so successive
builds can install over each other.

1. Create a new **empty** GitHub repository (e.g. `route-spoofer`).
2. Add it as a remote and push (the project is already a local git repo):

   ```bash
   git remote add origin git@github.com:<you>/route-spoofer.git
   git branch -M main
   git push -u origin main
   ```

3. Open the repo's **Actions** tab → the **Android Debug APK** run.
   (If it didn't auto-trigger, use **Run workflow** / `workflow_dispatch`.)
4. When it's green, open the run → **Artifacts** → download
   **`route-spoofer-apk`**. Inside are **`route-spoofer.apk`** and
   **`latest.json`**.
5. Sideload the APK onto your phone (see **Phone setup** below).

On a push to `main` the same job refreshes the rolling **`latest`** release with
both files, which is what the in-app updater reads (see section 5).

The GitHub-hosted `ubuntu-latest` runner already ships the Android SDK, so the
workflow produces a downloadable, installable APK with nothing installed locally.

---

## 2. Local build (Android Studio or Gradle CLI)

Requires the Android SDK. Node 20+ is also needed for the Capacitor sync step.

```bash
npm ci                       # install Capacitor + deps
npx cap sync android         # copy web assets + plugins into android/
```

**Android Studio:** `npx cap open android`, let Gradle sync, then
**Run** on a USB-connected device, or **Build → Build APK(s)**.

**Gradle CLI:**

```bash
cd android
./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

Install on a connected device with `adb install -r app-debug.apk`.

> Toolchain note: this project pins **Capacitor 7** (supports Node 20, requires
> **JDK 21**). The CI workflow uses Node 20 + Temurin JDK 21 to match. Use JDK 21
> for local Gradle builds too (Android Studio Koala+ bundles a compatible JDK).

---

## 3. One-time phone setup

To let the app actually drive device location you must select it as the system
mock-location app and grant runtime permissions.

1. **Enable Developer options:** Settings → About phone → tap **Build number**
   7 times.
2. **Sideload the APK:** copy `app-debug.apk` to the phone and open it. You may
   need to allow **Install unknown apps** for your file manager / browser.
3. **Select the mock app:** Settings → **Developer options** →
   **Select mock location app** → **Route Spoofer**.
4. **Launch Route Spoofer** and grant the prompts:
   - **Location** (Allow / While using the app)
   - **Notifications** (Android 13+) — required for the foreground service.

The app's in-app **"Enable mock GPS"** card checks both of these and gives you
shortcut buttons (**Grant permissions**, **Open Developer options**, **Re-check**).
When both rows show ✓, tap the big play button.

### Using it
- Tap the map to drop waypoints A → B → C…
- **Lock route** to guard against accidental edits — while locked, map taps and
  point drags are ignored so a stray tap can't add or move points. Tap again to
  unlock. (Routes start unlocked; locking is never automatic.)
- Set **Speed mode** (walk / run / bike) and fine-tune each mode's m/s value in
  the **Settings** dialog, plus **Emit every** (interval) and **Loop**
  (Off / Restart / Ping-pong).
- Press **Play**. Open Google Maps (or any consumer app) — it now follows the
  fake route. The persistent notification shows the mock GPS is active.
- **Stop** removes the test providers and resets to the start.

---

## 4. Customisation

### Map provider
In `www/index.html`, near the top of the script, these constants pick the
basemaps:

```js
const AMAP_TILE_URL  = 'https://webrd0{s}.is.autonavi.com/appmaptile?…';  // primary (高德)
const MAP_RASTER_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';  // fallback
```

The primary basemap is AMap (高德) raster tiles, loaded inside Leaflet — no SDK
or key required. If not a single AMap tile loads, the app falls back to the OSM
standard raster tiles. `console.info('[map] basemap: …')` logs which one
was chosen.

AMap tiles use **GCJ-02**, while the route and the injected GPS fixes are
**WGS-84**. `toMapLL()` / `fromMapLL()` convert at every map boundary (markers,
polylines, taps, drags, emitter, real-position dot), so routes stay aligned with
the basemap. Keep route data in WGS-84 — converting the stored points would make
the injected location offset for every other app.

Place search uses AMap's Web-service geocoding when `AMAP_WEB_KEY` is set (near
the search code); without a key it falls back to Nominatim. Get a key at
<https://console.amap.com/dev/key/app> (service type: Web服务).

After editing, re-run `npx cap sync android` (or rebuild) so the change reaches
the app.

### App id / name
Rename in **two** places, then `npx cap sync`:
- `capacitor.config.json` → `appId` (`com.routespoofer.app`) and `appName`
  (`Route Spoofer`).
- `android/app/build.gradle` → `namespace` + `applicationId`, and
  `android/app/src/main/res/values/strings.xml` (`app_name`,
  `title_activity_main`, `package_name`, `custom_url_scheme`).

If you change the Java/Kotlin package, also move the files under
`android/app/src/main/java/<package path>/` and update their `package`
declarations + the `<service>`/activity names in `AndroidManifest.xml`.

---

## 5. In-app updates (GitHub Releases)

Updates do **not** go through Google Play — there is no Play Core / Play Store
dependency. The app is sideloaded, so it updates itself from this repository's
rolling **`latest`** release:

1. On start (and throttled to once per 6 h) the web layer fetches
   `https://api.github.com/repos/<owner>/<repo>/releases/tags/latest` and parses
   the manifest `{ versionCode, versionName, sha256, url }` from the **release
   body** (release assets are served without CORS headers, so a WebView cannot
   fetch the `latest.json` asset directly — it is published anyway for plain HTTP
   clients and as a fallback). Reading through the API also avoids CDN cache
   staleness.
2. If `versionCode` is greater than the installed one, a banner appears above the
   deck: **Download** / **Later**. *Later* hides it for this session.
3. **Download** hands the APK URL to the native `AppUpdater` plugin
   (`android/app/src/main/java/com/routespoofer/app/AppUpdaterPlugin.kt`). It
   downloads to the app cache, verifies the SHA-256 from the manifest, checks the
   APK's package name **and signing certificate** against the running app, then
   opens the system installer through `FileProvider`. Progress is shown in the
   banner.
4. The first time, Android asks to allow **Install unknown apps** for Route
   Spoofer; the app deep-links straight to that settings screen. If a playback is
   running, it is stopped before installing.

### Signing (important)

The downloaded APK must be signed with the **same key** as the installed app,
otherwise Android refuses the update (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`).

This repository ships a fixed development key at
`android/ci/release.jks.b64` (PKCS12, alias `routespoofer`), and `android.yml`
decodes it before building, so **every CI build is signed identically** and can
install over the previous one. The key is public — it only proves "this update
came from the same build pipeline", the APK is still only fetched from this
repo's `latest` release.

For a private/Play build, override it with the four repository secrets
(Settings → Secrets and variables → Actions), which take precedence:

| Secret | Value |
| --- | --- |
| `KEYSTORE_BASE64` | `base64 -w0 release.jks` |
| `KEYSTORE_PASSWORD` | store password |
| `KEY_ALIAS` | key alias |
| `KEY_PASSWORD` | key password (same as store password for PKCS12) |

If you ever replace the committed key, the `versionCode`-guard alone is not
enough — a differently signed APK cannot be installed over the old one, so bump
the key only together with a one-time uninstall or a fresh install.

To build a signed APK locally:

```bash
base64 -d android/ci/release.jks.b64 > /tmp/release.jks
export KEYSTORE_PATH=/tmp/release.jks
export KEYSTORE_PASSWORD=tcjxlsyv94rn2mdq0e68gozpu1ikh5b3
export KEY_ALIAS=routespoofer KEY_PASSWORD=$KEYSTORE_PASSWORD
cd android && ./gradlew assembleRelease
```

Without any key the workflow still builds, but with a throwaway debug keystore
generated per run. Such APKs install fine once, but never update over an older
build — the job prints a warning saying exactly that.

### Testing

Install the current build, bump `versionCode`/`versionName` in
`android/app/build.gradle`, push to `main`, wait for the run to publish the
`latest` release, then open the app again (or wait for the 6 h check) — the
update banner should appear and install successfully.


## Project layout

```
fake-gps/
├─ www/index.html                # web UI (preview + control), single map constant
├─ capacitor.config.json         # appId / appName / webDir
├─ package.json                  # Capacitor 7 deps
├─ android/                      # native project (generated by cap, customised)
│  ├─ ci/release.jks.b64         # fixed development signing key used by CI
│  └─ app/src/main/
│     ├─ AndroidManifest.xml     # perms + <service> (foregroundServiceType=location)
│     └─ java/com/routespoofer/app/
│        ├─ MainActivity.java         # registers the FakeGps + AppUpdater plugins
│        ├─ FakeGpsPlugin.kt          # Capacitor bridge (start/pause/.../ensureReady)
│        ├─ AppUpdaterPlugin.kt       # self-update: download APK, verify, install
│        └─ MockLocationService.kt    # playback clock + GPS/NETWORK test-provider injection
├─ .github/workflows/android.yml # cloud APK build
└─ html-example/fake-gps.html    # original UX reference
```
