# Android App

The Android app wraps the existing web UI with Capacitor. The web build is generated into the ignored `capacitor-www/` directory; the native Android Studio project lives in `android/` and is versioned with the source.

## Requirements

- Node.js 22 or newer
- Android Studio with Android SDK Platform 36 and Build Tools installed
- JDK 17 or newer (Android Studio's bundled JBR is recommended, JDK 21 also works)
- An Android device or emulator for `npm run android:debug`

## Build and run

```sh
npm install
npm run android:sync
npm run android:open
```

In Android Studio, wait for Gradle sync, then run the app or choose **Build > Build Bundle(s) / APK(s) > Build APK(s)**. For a connected device, `npm run android:debug` builds and installs the debug app.

After changing web code, run `npm run android:sync` before building. To build a web-only release, use the existing GitHub Pages workflow; Android packaging does not change that deployment.

Command-line build of the debug APK plus the staged website folder:

```sh
npm run android:sync
cd android && gradlew.bat assembleDebug && cd ..
npm run release:stage
```

The version comes from `package.json`. `android/app/build.gradle` derives `versionCode` as
`major * 1000000 + minor * 1000 + patch`, so **bump `package.json` before every release** or Android
will refuse to install the new APK over the old one.

## Website and APK run the same source

`index.html` loads `src/main.js` directly — there is no bundler on the website. The APK builds the
same `src/` through `vite.android.config.js`. Two rules keep the two in sync:

1. **No static bare-module imports under `src/`.** The browser cannot resolve `@capacitor/core`
   without a bundler; one such import breaks the whole site at load time (`Failed to resolve module
   specifier`). `src/native.js` wraps the platform probe and every native plugin is loaded with a
   literal `await import(...)` inside a function, so the code path never runs on the web.
2. **Native-only features must degrade by themselves.** `isNativePlatform()` returns `false` on the
   web, so the notification page, the updater and file sharing fall back to honest messages instead
   of throwing. `tools/check.mjs` fails the build if a bare import creeps back in.

The only intended differences are the genuinely device-specific parts: local notifications,
APK self-update, the share sheet for exports, and no service worker inside the WebView.

## Notifications

Open the **通知** page in the app. Toggling any switch asks for the system notification permission
immediately, so a tap always has a visible effect; saving then (re)schedules everything.

- **复盘提醒** — morning / noon / evening, each with its own time. Daily repeats use
  `schedule: { on: { hour, minute }, repeats: true }`. Do **not** use `{ at, repeats: true }`:
  Capacitor's Android implementation then treats the gap between "now" and the first fire as the
  repeat interval, so a 09:00 reminder saved at 08:00 fires every hour.
- **任务提醒** — one single-shot reminder per unfinished task that has a `plannedStart` in the
  future; editing or completing a task re-syncs them. Capped at 120 pending task reminders.
- **发送测试提醒** — schedules a notification 5 seconds out. If that one never arrives, the problem
  is the system permission or the channel, not the scheduling logic.
- **让提醒更准时** — Android 12+ "Alarms & reminders" access. Without it reminders still arrive but
  may be a few minutes late; the plugin falls back to an inexact alarm instead of failing.

Tapping a notification opens the app and navigates: review reminders go to 复盘, task reminders to
任务 (and open that task), `schedule_notification` reminders go to AI 对话. Navigation requested
before the first data load is queued and replayed after it, so a cold start from a notification
still lands on the right page.

A dedicated `msa-reminders` channel is created with high importance so reminders pop up as a
heads-up banner instead of silently landing in the shade.

The website can store these settings, but browsers do not reliably deliver notifications after the
page closes — the notification page says so instead of pretending.

## Automatic updates

Three layers, all pointing at the public GitHub releases of this repository:

1. **In-app on launch** (`src/updates.js`) — checks at most once per 24 hours (cached in
   `localStorage`), and when a newer `vX.Y.Z` release exists it asks Android's `DownloadManager` to
   fetch `MyStudyAgent.apk` over Wi-Fi only, then shows the **安装更新** button in Settings → 应用更新.
2. **Background daily check** (`UpdateCheckScheduler` / `UpdateCheckWorker`) — a WorkManager job
   every 24 hours that repeats the same check without the app being open.
3. **Install** (`AppUpdaterPlugin`) — opens the system package installer. Android asks for
   confirmation; nothing is installed silently, and app data survives the upgrade.

The download URL is validated in native code: it must be `https://github.com/.../releases/download/...`.
Users who installed the app outside the store may need to allow "install unknown apps" once.

## Data and exports

The APK has its own WebView storage, separate from Chrome and the website. Export a JSON backup from the website and import it in the APK to move existing data. JSON and Markdown exports in the APK open Android's share sheet, where they can be saved to local storage or another app.

## Release APK

Use Android Studio's **Build > Generate Signed Bundle / APK** flow for a signed release. Keep the signing keystore and passwords outside the repository. After building an APK, put the website and APK in one folder and add an APK download link to the page with:

```sh
npm run android:sync
npm run release:stage
```

By default the staging script uses the debug APK. To stage a signed APK instead, pass its path:

```sh
npm run release:stage -- android/app/build/outputs/apk/release/app-release.apk
```

The generated `release/` folder contains the static website and `MyStudyAgent.apk` side by side. Deploy that folder as a website directory to let visitors download the APK.

Publish the same APK as a GitHub release asset so installed apps can find it — the asset name must be
exactly `MyStudyAgent.apk`, and the tag must be `v<package.json version>`:

```sh
gh release create v1.3.0 release/MyStudyAgent.apk --title "My Study Agent 1.3.0" --notes "..."
```

`release/` is gitignored; the release asset is the distribution channel.
