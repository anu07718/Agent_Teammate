# Nirnaya for Android

The Nirnaya app for phones: the office, the Task Status sheet, approvals in the chat, and the workspace
with its tab bar. It connects to a Nirnaya server: the Windows app, `python -m nirnaya`, Docker, or a
server you host.

**Install:** copy `dist/Nirnaya-0.1.0.apk` to the phone and open it. Allow "install unknown apps" for
the app you opened it from. It needs Android 7.0 or newer.

## Connect it to a server

The phone does not run the server itself. FastAPI needs pydantic-core, which has no Android build, so the
server cannot be packed into the APK. Run the server where the cases live instead:

1. On a computer on the same Wi-Fi, start a server that listens on the network:
   ```bash
   python -m nirnaya --host 0.0.0.0 --port 8000      # or: docker run -p 8000:8000 nirnaya
   ```
   The Windows app's own server only listens on the computer itself, so the phone can't reach it; use
   the command above.
2. Find the computer's address: `ipconfig` on Windows, `ip addr` on Linux. For example, 192.168.1.20.
3. Open Nirnaya on the phone. On first launch it asks for the server: enter `192.168.1.20:8000` and
   press **CONNECT**. It remembers the address. To change it later, go to Workspace → Settings → Server.

The server has no login. Only run it with `--host 0.0.0.0` on a network you trust, or put it behind
HTTPS and your own sign-in when you host it.

## Folder

| Path | What it is |
|---|---|
| `capacitor.config.json` | the app id (`app.nirnaya.mobile`), name, and plain-HTTP settings so it can reach a server on your Wi-Fi |
| `android/` | the Android project: manifest (cleartext allowed for LAN servers), icons and launch screen from `tools/make_icons.py` |
| `build.sh` | builds `web/`, copies it in, syncs Capacitor, runs Gradle |
| `dist/` | the built APK |

## Build it

Needs node 22, JDK 21 and the Android SDK (platform 36, build tools 36):

```bash
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
bash apk/build.sh                         # → apk/dist/Nirnaya-<ver>.apk
```

The APK is signed with the Android debug key, which is fine for installing by hand. Each build machine
has its own debug key, so an APK built on another machine installs only after the old one is removed. For
a store release, set `NIRNAYA_KEYSTORE`, `NIRNAYA_KEYSTORE_PASS`, `NIRNAYA_KEY_ALIAS` and
`NIRNAYA_KEY_PASS`. `build.sh` then also writes a signed `Nirnaya-<ver>-release.apk`.

## What has been tested, and how

- The APK was built with Gradle and checked with `aapt2` and `apksigner`: package, version, target SDK
  36, INTERNET permission, cleartext allowed, the web app inside `assets/public`, a valid signature.
- The web files inside the APK (`assets/public`) are byte for byte the `web/dist` build that every browser
  suite tested, apart from Capacitor's own `cordova.js` and `cordova_plugins.js`.
- The phone flow (`web/e2e/phone-client.mjs`, 5 checks) ran in Chromium at phone size on the files
  unpacked from the APK itself (`APP_DIST=…/assets/public`). It served them from their own origin, the way
  the APK serves them from `http://localhost`, and marked the page as the native shell. First launch asked for the server; entering the address connected the office live; a message
  typed on the phone became a resolved case on the server; the address survived a restart.

This build machine has no hardware virtualisation, so the Android emulator cannot run here. The APK has
not been opened on a phone or emulator yet. Please try it on a device.
