# The last test run

2 October 2026: free language models instead of Anthropic, and shared workspaces through a free Firebase
Realtime Database. Each browser suite ran on its own fresh server. Email went through a real SMTP/IMAP
server (GreenMail). The relay went through Google's Firebase database emulator, with
firebase/database.rules.json loaded. WhatsApp, Twilio and n8n went through signed local stand-ins. What each
suite covers is in [workflow.md](../workflow.md#13-test-everything-automatically).

Not covered on this build machine:
- the owner's real Firebase project, real Groq/Gemini/OpenRouter/Mistral keys, and real Gmail, Meta and
  Twilio accounts, which all need the owner's own sign-ups;
- the Windows window itself, because wine has no WebView2;
- the APK on a phone, because there is no emulator without hardware virtualisation.

## The website (`make test-all`)

The final build, after the fixes the first full run found:

| Suite | Checks | Result | Notes |
|---|---|---|---|
| backend (pytest) | 94 + 1 skipped | pass | the skip is the real-model test, run separately below |
| web typecheck + build | 1 | pass | |
| run | 17/17 | pass | |
| workflow | 15/15 | pass | |
| fields-office | 19/19 | pass | first full run; the office itself did not change after it |
| fields-workspace | 24/24 | pass | includes the new Settings → Language model card |
| fields-flows | 26/26 | pass | |
| flows | 9/9 | pass | |
| team | 9/9 | pass | |
| phone-client | 8/8 | pass | |
| channels | 22/22 | pass | |
| workspace | 14/14 | pass | create, join from the plain web app and from a second server, live events, approve on the host's agents, files through the host, host-only settings, new code, leave, stop |
| audit (every view and button) | 262 clicks | pass | 0 problems |

What the first full run caught, now fixed:
- The person+ button was named "Share or join a workspace", so a search for the **Workspace** button found
  two buttons. It is now called "Work together".
- In the workspace bar the clock was wrapped in a span, so its fixed width did not apply. The bar moved by
  a pixel or two every second, and the audit could not click the theme button.
- The model switches in Settings waited for the server before showing the change.
- A bare `.dark` selector turned the office's dark buttons pale.

## The Windows app (`make test-all TARGET=exe QUICK=1`)

The server bundled in `exe/build/Nirnaya`, under wine 11 with its own Python:

| Suite | Checks | Result |
|---|---|---|
| run | 17/17 | pass |
| workflow | 15/15 | pass |
| fields-workspace | 24/24 | pass |
| fields-flows | 26/26 | pass |
| flows | 9/9 | pass |
| team | 9/9 | pass |
| phone-client | 8/8 | pass |
| channels | 22/22 | pass |
| workspace | not finished | the run was stopped here to push |

The APK run was not started this time. The APK's web files are the same build the website suites tested.

## A real free model

`NIRNAYA_TEST_LLM_URL=http://127.0.0.1:8089/v1 pytest tests/test_llm.py -k real`, against Llama 3.2 1B (a
1.1 GB llamafile, CPU only, served with the same OpenAI API as Ollama): **pass**. A whole case ran through
the model, and its reply passed the Promise Guard. It named 2 of 3 intents right, misread one amount
(₹2,440 for ₹2,450) and made up a merchant. That is why the model only advises.
