# The last full test run

`make test-all` for each build, on 2 October 2026, on the code of commit `17c9bac`. Each browser suite ran
on its own fresh server; the email checks went through a real SMTP and IMAP server (GreenMail) on the
same machine, and WhatsApp, Twilio and n8n through local stand-ins that sign their webhooks the way the
real providers do. What each suite covers is in [workflow.md](../workflow.md#13-test-everything-automatically).

Not covered here, because this build machine cannot do it: real Gmail, Meta and Twilio accounts (they
need the owner's credentials and a public address), the Windows window itself (wine has no WebView2),
and the APK on a phone (no Android emulator without hardware virtualisation).

## The website (`make test-all`)

| Suite | Checks | Result | Time | Notes |
|---|---|---|---|---|
| backend (pytest) | 77 | pass | 1m 7s | 77 passed, 1 warning in 65.78s (0:01:05) |
| web typecheck + build | 1 | pass | 0m 8s | ✓ built in 4.74s |
| run | 17/17 | pass | 2m 36s |  |
| workflow | 15/15 | pass | 3m 10s |  |
| fields-office | 19/19 | pass | 22m 11s |  |
| fields-workspace | 23/23 | pass | 1m 23s |  |
| fields-flows | 26/26 | pass | 1m 54s |  |
| flows | 9/9 | pass | 0m 15s |  |
| team | 9/9 | pass | 1m 12s |  |
| phone-client | 8/8 | pass | 0m 36s |  |
| channels | 22/22 | pass | 1m 11s |  |
| audit (every view and button) | 226 clicks | pass | 10m 29s | 0 problem(s)  |

**Everything passed.**

## The Windows app (`make test-all TARGET=exe`)

The server bundled in `exe/build/Nirnaya` (the same files the installer packs), started under wine 11
with its own Python.

| Suite | Checks | Result | Time | Notes |
|---|---|---|---|---|
| run | 17/17 | pass | 2m 41s |  |
| workflow | 15/15 | pass | 3m 26s |  |
| fields-office | 19/19 | pass | 23m 27s |  |
| fields-workspace | 23/23 | pass | 1m 37s |  |
| fields-flows | 26/26 | pass | 2m 22s |  |
| flows | 9/9 | pass | 0m 19s |  |
| team | 9/9 | pass | 1m 19s |  |
| phone-client | 8/8 | pass | 0m 41s |  |
| channels | 22/22 | pass | 1m 17s |  |
| audit (every view and button) | 226 clicks | pass | 10m 48s | 0 problem(s)  |

**Everything passed.**

## The Android app (`make test-all TARGET=apk`)

The web files unpacked from `apk/dist/Nirnaya-0.1.0.apk`: first compared byte for byte with `web/dist`,
then served by the server for every suite, and from their own origin as the native shell for the phone
suite.

| Suite | Checks | Result | Time | Notes |
|---|---|---|---|---|
| apk files = web/dist | 1 | pass | 0m 0s | 145 files, the same bytes |
| run | 17/17 | pass | 2m 39s |  |
| workflow | 15/15 | pass | 3m 22s |  |
| fields-office | 19/19 | pass | 22m 46s |  |
| fields-workspace | 23/23 | pass | 1m 25s |  |
| fields-flows | 26/26 | pass | 2m 16s |  |
| flows | 9/9 | pass | 0m 15s |  |
| team | 9/9 | pass | 1m 9s |  |
| phone-client | 8/8 | pass | 0m 36s |  |
| channels | 22/22 | pass | 1m 11s |  |
| audit (every view and button) | 226 clicks | pass | 10m 30s | 0 problem(s)  |

**Everything passed.**
