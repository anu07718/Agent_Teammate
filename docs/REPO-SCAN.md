# What Nirnaya takes from the 18 reference projects

Each project was cloned and read: its README, licence, structure and the code behind the feature that
matters. The table says what each one is, whether its code can legally sit inside a commercial product,
and what Nirnaya actually uses, with the file where it lives.

**Why not paste every repository in.** Together they are well over two gigabytes of code in eight
languages (Python, TypeScript, Go, C, Zig, Rust, C#), mostly tools for *coding* agents rather than for
payment support. Four of them carry licences that forbid it outright: AGPL (OpenMontage, Recordly,
codegraff) would force the whole of Nirnaya open under AGPL, including its network service; agents-office
is noncommercial and forbids rebranding or using it to front another agent system; the error-tracking
server is under a non-compete licence. So Nirnaya takes each project's working *mechanism*, rebuilt for
payment disputes, and uses the permissively licensed libraries as ordinary dependencies.

| # | Project | What it is | Licence | What Nirnaya uses | Where |
|---|---|---|---|---|---|
| 1 | **orca** | IDE for running many coding agents in parallel; Electron + React + Tailwind + shadcn, with a phone companion | MIT | The UI/UX: title bar with live connectors, activity bar with shortcuts, grouped list with status dots, tabbed workspace, bottom log panel, status bar, neutral dark-first theme. Its desktop + phone structure is the plan for the EXE and APK | `web/src/App.tsx`, `web/src/views/Workspace.tsx`, `web/src/index.css` |
| 2 | **agents-office** | 3D isometric office where agents in departments do tasks, with a task bar, a "brain", connectors and routines | PolyForm Noncommercial + no-rebrand / no-fronting terms | **Design reference only; no code, assets, fonts or marks.** Copying its code into Nirnaya was refused by the build environment's safety check, and the licence needs the author's written permission for a renamed, commercial copy that fronts another agent system. Nirnaya's office was written from scratch in three.js and React from screenshots, with the same layout and flow: six department pods around a Brain, a card over each pod, name pills, connector wires from the top bar, a Task Status panel that reads a sentence back before it is added, a chat rail per agent with approvals in it, a company board, a Brain graph and a calendar | `web/src/office/` |
| 3 | **pixel-agents** | Coding agents shown as pixel characters working in an office | MIT (its characters derive from a third-party pack) | The idea that a character's pose follows its live state: typing while a step runs, standing and waving while it waits for you. Nirnaya's people are low-poly 3D, built in code; none of its image assets are used | `web/src/office/scene.ts`, `web/src/office/models.ts` |
| 4 | **hermes-agent** | Self-improving agent framework: tools, skills, memory, cron, messaging gateways, layered approvals | MIT | Approval "floors" (hard blocks evaluated before any approval path can run), a persona/skill file per agent, cron-style routines set in plain words | `backend/nirnaya/sentry_gate.py`, `backend/nirnaya/personas/`, `backend/nirnaya/routines.py`, `backend/nirnaya/schedule.py` |
| 5 | **724-office** | 24/7 agent in plain Python: tool loop, per-tool circuit breaker, persistent cron, self-checks | MIT | Circuit breaker per tool (opens after 3 consecutive failures), persistent routines, health endpoint | `backend/nirnaya/gateway.py`, `backend/nirnaya/routines.py` |
| 6 | **agency-agents** | Library of agent personas as Markdown with front matter | MIT | The persona file format. Nirnaya's 19 agents have their own personas, written for this domain | `backend/nirnaya/personas/*.md`, `backend/nirnaya/agents.py` |
| 7 | **deja-vu** | Local memory across coding-agent sessions: knows which decisions held and warns when "the ground moved" | MIT | Case memory: every resolved case indexed (BM25, no embeddings) with its outcome state (accepted / rejected / auto) and a ground-moved flag when the transaction changed since | `backend/nirnaya/memory.py` |
| 8 | **Graft** | Context graph of a codebase for coding agents; typed links, content-hashed sources | MIT | A context graph of customers, accounts, UPI IDs, transactions, merchants, cases and policies, with typed links | `backend/nirnaya/graph.py`, Brain view |
| 9 | **codebase-memory-mcp** | Code knowledge graph served over MCP (`search_graph`, `trace_path`, …) | MIT | Nirnaya is an MCP server too: graph and memory search, rail status reads, case submit/status, and the Confidence Layer's `score_action` | `backend/nirnaya/api.py` (`/mcp`) |
| 10 | **agent-vision-toolkit** | Vision tools for text-only agents: long-screenshot OCR, intent-aware image reading | MIT | Evidence from a customer's screenshot or statement: OCR / text extraction, tokenised before anyone reads it, mined for UTR, amount and date | `backend/nirnaya/docparse.py` |
| 11 | **MinerU** | Layout-aware PDF → Markdown | Apache-2.0 + extra terms (attribution when offered online; separate licence above 100M MAU or $20M monthly revenue) | Optional parser for bank statements and KYC PDFs, used only when installed; pypdf otherwise | `backend/nirnaya/docparse.py` |
| 12 | **OfficeCLI** | Office documents for agents: create, validate and render .docx/.xlsx/.pptx | Apache-2.0 | Every case exports as an evidence workbook; when the binary is present it is validated and rendered for preview | `backend/nirnaya/reports.py` |
| 13 | **univer** | Spreadsheet and document engine | Apache-2.0 | Dependency: the live ledger opens as a real spreadsheet (transactions, accounts, credits and disputes) | `web/src/views/Ledger.tsx`, `web/src/views/univerSheet.ts` |
| 14 | **OpenResearch** | Local-first research-agent workspace with a git-native experiment tree | MIT | Experiment archive: every benchmark run is stored with the α settings and policy hash it ran under, so threshold experiments can be compared | `backend/nirnaya/benchmark.py`, Benchmark view |
| 15 | **sentry** (the error-tracking platform) | Error monitoring server | FSL-1.1 (non-compete; Apache after two years) | Server code not used. Its official SDKs (MIT) report errors from the API and the web app when a DSN is set | `backend/nirnaya/api.py`, `web/src/main.tsx` |
| 16 | **OpenMontage** | Agentic video production | AGPL-3.0 | Not merged. Can be used on its own to cut the demo video | — |
| 17 | **Recordly** | Screen recorder and editor | AGPL-3.0 | Not merged. Can be used on its own to record the demo | — |
| 18 | **codegraff** | Code graph engine | Modified AGPL-3.0 | Not merged | — |

Name clash to be aware of: Nirnaya's own intake gate is also called **Sentry** (the risk cascade in
`sentry_gate.py`). It is unrelated to the error-monitoring SDK.
