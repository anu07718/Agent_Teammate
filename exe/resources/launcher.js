// The desktop launcher. Neutralino opens this page first; it starts the bundled Nirnaya server (or finds
// one already running), waits for it to answer, then turns the window into the app itself. The server
// is started with --exit-with <this process>, so closing the window stops it too.
/* global Neutralino, NL_OS, NL_PATH, NL_PID */

const PORTS = [8765, 8766, 8767, 8768, 8769];
const READY_WITHIN_MS = 120000;

const $ = (id) => document.getElementById(id);
const say = (text) => { $("status").textContent = text; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const win = () => NL_OS === "Windows";
const join = (...parts) => parts.join(win() ? "\\" : "/");
const native = (p) => (win() ? p.replace(/\//g, "\\") : p);

let child = null; // { id, pid, port, exited, code, err }
let logFile = "";
let appDir = ""; // where Nirnaya is installed, absolute (NL_PATH can be relative, e.g. ".")

Neutralino.init();
Neutralino.events.on("spawnedProcess", (e) => {
  if (!child || e.detail.id !== child.id) return;
  if (e.detail.action === "stdErr") child.err = (child.err + e.detail.data).slice(-4000); // before --log takes over
  if (e.detail.action === "exit") {
    child.exited = true;
    child.code = e.detail.data;
  }
});

/** "nirnaya" if a Nirnaya server answers on the port, "free" if nothing answers, "taken" otherwise */
async function probe(port) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) return "taken";
    const j = await r.json();
    return j && j.ok && "policy_hash" in j ? "nirnaya" : "taken";
  } catch {
    return "free";
  } finally {
    clearTimeout(t);
  }
}

async function exists(path) {
  try {
    await Neutralino.filesystem.getStats(path);
    return true;
  } catch {
    return false;
  }
}

async function dataDir() {
  if (win()) {
    const base = (await Neutralino.os.getEnv("LOCALAPPDATA")) || (await Neutralino.os.getEnv("APPDATA"));
    return join(base, "Nirnaya");
  }
  const xdg = await Neutralino.os.getEnv("XDG_DATA_HOME");
  return join(xdg || join(await Neutralino.os.getEnv("HOME"), ".local", "share"), "nirnaya");
}

/** How to run the bundled server: the embedded Python on Windows, python3 elsewhere. */
async function serverCommand(port, data) {
  const app = appDir;
  const web = join(app, "web");
  const args = [
    "-m", "nirnaya", "--host", "127.0.0.1", "--port", String(port),
    "--db", `"${join(data, "nirnaya.db")}"`, "--log", `"${logFile}"`, "--exit-with", String(NL_PID),
  ];
  if (await exists(web)) args.push("--web", `"${web}"`);
  if (win()) {
    return { command: [`"${join(app, "python", "pythonw.exe")}"`, ...args].join(" "), cwd: app };
  }
  const bundled = join(app, "python", "bin", "python3");
  const python = (await exists(bundled)) ? `"${bundled}"` : "python3";
  const backend = (await exists(join(app, "backend", "nirnaya"))) ? join(app, "backend") : join(app, "..", "backend");
  return { command: [python, ...args].join(" "), cwd: backend };
}

const MARK = "---- Nirnaya window: starting the server";

/** this run's part of the log (the launcher writes MARK before each start) */
async function tail(path, lines = 18) {
  try {
    const text = await Neutralino.filesystem.readFile(path);
    const at = text.lastIndexOf(MARK);
    const run = at < 0 ? text : text.slice(text.indexOf("\n", at) + 1);
    return run.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function fail(why, log) {
  document.body.classList.add("failed");
  $("failed").hidden = false;
  $("why").textContent = why;
  $("log").textContent = log || "";
  $("log").scrollTop = $("log").scrollHeight; // the last lines say what went wrong
  say("");
}

async function start() {
  document.body.classList.remove("failed");
  $("failed").hidden = true;
  const data = await dataDir();
  logFile = join(data, "nirnaya.log");
  appDir = native(await Neutralino.filesystem.getAbsolutePath(NL_PATH).catch(() => NL_PATH));

  for (const port of PORTS) {
    say(`Looking for a Nirnaya server on port ${port}…`);
    const seen = await probe(port);
    if (seen === "nirnaya") return open(port);
    if (seen === "taken") continue;

    say("Starting the Nirnaya server…");
    const { command, cwd } = await serverCommand(port, data);
    await Neutralino.filesystem.createDirectory(data).catch(() => {});
    await Neutralino.filesystem.appendFile(logFile, `\n${MARK} on port ${port}, ${new Date().toISOString()}\n`).catch(() => {});
    try {
      const p = await Neutralino.os.spawnProcess(command, { cwd });
      child = { id: p.id, pid: p.pid, port, exited: false, code: null, err: "" };
    } catch (err) {
      return fail("Couldn't start the server.", `${command}\n\n${err && err.message ? err.message : err}`);
    }

    const t0 = Date.now();
    while (Date.now() - t0 < READY_WITHIN_MS) {
      await sleep(400);
      if ((await probe(port)) === "nirnaya") return open(port);
      if (child.exited) break;
      const s = Math.round((Date.now() - t0) / 1000);
      if (s >= 4) say(`Starting the Nirnaya server… ${s}s (the first start takes longest)`);
    }
    const log = [child.err.trim(), await tail(logFile)].filter(Boolean).join("\n…\n");
    if (child.exited && /address already in use|only one usage of each socket address|error while attempting to bind/i.test(log)) {
      continue; // someone else holds this port: try the next one
    }
    if (!child.exited) await Neutralino.os.updateSpawnedProcess(child.id, "exit").catch(() => {});
    return fail(child.exited ? `The server stopped (exit code ${child.code}).` : "The server didn't answer in time.", log);
  }
  fail("No free port for the server.", `Tried ${PORTS.join(", ")}.`);
}

function open(port) {
  say("Opening…");
  window.location.replace(`http://127.0.0.1:${port}/`);
}

$("retry").onclick = () => start();
$("openlog").onclick = () => logFile && Neutralino.os.open(logFile).catch(() => {});
$("quit").onclick = () => Neutralino.app.exit();

start();
