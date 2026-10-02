# Nirnaya for Windows

A desktop app: Nirnaya's own window with the whole of Nirnaya inside. The server, the office and the
workspace all run on the computer. No Python, Node or browser needs to be installed.

**Install:** run `dist/Nirnaya-Setup-0.1.0-x64.exe`. It needs 64-bit Windows 10 or 11 and no admin
rights. It installs for the current user in `%LOCALAPPDATA%\Programs\Nirnaya` and adds Start-menu and
desktop shortcuts. The installer and the app are not code-signed yet, so SmartScreen may say "Windows
protected your PC": choose **More info → Run anyway**.

Your cases, the audit trail and the log are kept in `%LOCALAPPDATA%\Nirnaya` (`nirnaya.db`,
`nirnaya.log`). Uninstalling asks whether to delete them too.

## How it works

```
Nirnaya.exe (Neutralino window, WebView2)
  └─ resources/launcher.js  — finds a free port (8765–8769) or a Nirnaya server already running there
       └─ python\pythonw.exe -m nirnaya --host 127.0.0.1 --port 8765
             --db %LOCALAPPDATA%\Nirnaya\nirnaya.db --log …\nirnaya.log --web <app>\web --exit-with <window pid>
  └─ once /api/health answers, the window opens http://127.0.0.1:8765/ (the same app as the website)
```

- The server listens on 127.0.0.1 only: other machines on the network cannot reach it.
- `--exit-with` stops the server when the window closes, even if the window crashes.
- If the server does not start, the window shows the reason and the end of the log, with **Try again**
  and **Open the log**.
- To use Claude for understanding and replies, set `ANTHROPIC_API_KEY` in your Windows user environment
  variables before opening Nirnaya. Everything else works offline.

## Folder

| Path | What it is |
|---|---|
| `neutralino.config.json` | the window: title, size, icon, which native calls the launcher may use |
| `resources/` | the launcher page shown while the server starts (`index.html`, `launcher.js`, `launcher.css`, icon) |
| `installer.nsi` | the NSIS installer script (per-user; installs WebView2 if Windows lacks it) |
| `requirements-win.txt` | the Python packages bundled for Windows, pinned |
| `build.sh` | builds the app folder and the installer |
| `assets/` | the icon (`.ico`) and the installer pictures, drawn by `tools/make_icons.py` |
| `THIRD-PARTY.txt` | the programs the app bundles and their licences |
| `dist/` | the built installer |

## Build it

On Linux or WSL:

```bash
sudo apt install nsis unzip curl       # plus node 22 and python3 with pip
bash exe/build.sh                       # → exe/build/Nirnaya/ and exe/dist/Nirnaya-Setup-<ver>-x64.exe
```

`build.sh` builds `web/` and downloads Neutralino, the embeddable Python 3.12 and the WebView2 bootstrapper
into `exe/.cache`. It installs the win_amd64 wheels from `requirements-win.txt` into the bundled Python,
copies `backend/nirnaya` and `web/dist`, then packs everything with NSIS. With wine 10 or newer installed
(wine 9 lacks a C-runtime function numpy needs), it also stamps the icon onto `Nirnaya.exe` and runs the
bundled Python once as a check.

## What has been tested, and how

The build machine is Linux, so the Windows parts were tested with wine 11:
- The installer from `dist/` was installed silently into a fresh wine profile, and the server was started
  from the installed folder with the installed Python, through `cmd.exe /c` as the window does. Every
  browser suite then passed against it:
  - `run.mjs` (17 checks)
  - `workflow.mjs` (14): `workflow.md` followed step by step
  - `fields-office.mjs` (19)
  - `fields-workspace.mjs` (23): on a fresh database. On a server the other suites had already used, one
    check differed, and it should: approved recalibrations had taught it to refund a duplicate charge
    outright, so there was no undo to press.
  - `fields-flows.mjs` (26)
  - `phone-client.mjs` (5)
- After the channels were added: `make test-all TARGET=exe` started the rebuilt app folder's server (the
  same files the installer packs) under wine with its bundled Python, fresh for each suite, and every
  suite passed against it: `run` (17), `workflow` (15), `fields-office` (19), `fields-workspace` (23),
  `fields-flows` (26), `flows` (9), `team` (9), `phone-client` (8), `channels` (22: real email through a
  local SMTP and IMAP server, WhatsApp and Twilio stand-ins, n8n, approve by email, the call page, the
  access-key lock screen) and the audit (226 clicks, 0 problems). The report is in
  [docs/test-report.md](../docs/test-report.md).
- The installer ran silently: files, shortcuts and the uninstall entry were created. The uninstaller
  removed them and kept the user's data.
- The exact command the window uses (`cmd.exe /c "…"`) worked from a folder with a space in its name. The
  server stopped when its parent process ended.
- The launcher page (the same `resources.neu`) ran in the Linux build of the window under a virtual
  display. It showed the splash, started the server, opened the office and stopped the server when the
  window was closed (4 seconds after the close, in the last run). It reused a server that was already running, and it showed the error screen when the
  server failed.

Wine has no WebView2, so the Windows window itself (Neutralino on WebView2) has not been opened on real
Windows here. Please try the installer on a Windows machine.
