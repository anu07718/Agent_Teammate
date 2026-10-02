# The last full test run

`make test-all` for each build, on 2 October 2026, on the code of commit `c7918ed` (one look for the
office and the workspace). Each browser suite ran on its own fresh server; the email checks went through a
real SMTP and IMAP server (GreenMail) on the same machine, and WhatsApp, Twilio and n8n through local
stand-ins that sign their webhooks the way the real providers do. What each suite covers is in
[workflow.md](../workflow.md#13-test-everything-automatically).

Not covered here, because this build machine cannot do it: real Gmail, Meta and Twilio accounts (they
need the owner's credentials and a public address), the Windows window itself (wine has no WebView2),
and the APK on a phone (no Android emulator without hardware virtualisation).

The office suite took about 40 minutes on each build (22 minutes in the previous run). Most of its time
is clicks in the 3D office, which wait for stable frames under software rendering.

## The website (`make test-all`)

| Suite | Checks | Result | Time | Notes |
|---|---|---|---|---|
| backend (pytest) | 77 | pass | 1m 31s | 77 passed, 1 warning in 89.19s (0:01:29) |
| web typecheck + build | 1 | pass | 0m 13s | ✓ built in 7.97s |
| run | 17/17 | pass | 5m 8s |  |
| workflow | 15/15 | pass | 5m 28s |  |
| fields-office | 19/19 | pass | 40m 7s |  |
| fields-workspace | 23/23 | pass | 2m 0s |  |
| fields-flows | 26/26 | pass | 3m 2s | first run 25/26: one check read a run's state as "waiting", which is now shown in capitals; the check ignores case now, rerun 26/26 |
| flows | 9/9 | pass | 0m 24s |  |
| team | 9/9 | pass | 1m 51s |  |
| phone-client | 8/8 | pass | 0m 58s |  |
| channels | 22/22 | pass | 1m 53s | first run 20/22: two checks read "on" / "off" on the channel cards, now in capitals; fixed the same way, rerun 22/22 |
| audit (every view and button) | 238 clicks | pass | 15m 6s | 0 problem(s)  |

**Everything passed** after the two test fixes in the notes. Both were tests reading capitalised labels
with `innerText`; the app was right.

The header was also checked at 360, 390, 768, 1024, 1280, 1440 and 1920 px in both themes: it fits on one
line, nothing sticks out, and the page never scrolls sideways.

## The Windows app (`make test-all TARGET=exe`)

The server bundled in `exe/build/Nirnaya` (the same files the installer packs), started under wine 11
with its own Python.

| Suite | Checks | Result | Time | Notes |
|---|---|---|---|---|
| run | 17/17 | pass | 4m 44s |  |
| workflow | 15/15 | pass | 5m 41s |  |
| fields-office | 19/19 | pass | 40m 34s |  |
| fields-workspace | 23/23 | pass | 2m 16s |  |
| fields-flows | 26/26 | pass | 2m 18s |  |
| flows | 9/9 | pass | 0m 30s |  |
| team | 9/9 | pass | 1m 55s |  |
| phone-client | 8/8 | pass | 1m 6s |  |
| channels | 22/22 | pass | 1m 37s |  |
| audit (every view and button) | 238 clicks | pass | 15m 48s | 0 problem(s)  |

**Everything passed.**

## The Android app (`make test-all TARGET=apk`)

The web files unpacked from `apk/dist/Nirnaya-0.1.0.apk`: first compared byte for byte with `web/dist`,
then served by the server for every suite, and from their own origin as the native shell for the phone
suite.

| Suite | Checks | Result | Time | Notes |
|---|---|---|---|---|
| apk files = web/dist | 1 | pass | 0m 0s | 145 files, the same bytes |
| run | 17/17 | pass | 4m 19s |  |
| workflow | 15/15 | pass | 5m 21s |  |
| fields-office | 19/19 | pass | 40m 52s |  |
| fields-workspace | 23/23 | pass | 1m 57s |  |
| fields-flows | 26/26 | pass | 2m 24s |  |
| flows | 9/9 | pass | 0m 23s |  |
| team | 9/9 | pass | 1m 55s |  |
| phone-client | 8/8 | pass | 0m 57s |  |
| channels | 22/22 | pass | 1m 28s |  |
| audit (every view and button) | 238 clicks | pass | 15m 11s | 0 problem(s)  |

**Everything passed.**
