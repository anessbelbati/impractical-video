// Probe, run by Node: asks the real Codex which hooks it loads from the files the app writes.
// Codex's app server answers "hooks/list" without anyone being signed in.
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setupAgentProject } from "../../desktop/agent-setup.mjs";

const npmRoot = spawnSync("npm root -g", { encoding: "utf8", shell: true }).stdout.trim();
const codexScript = path.join(npmRoot, "@openai", "codex", "bin", "codex.js");
console.log("codex:", codexScript, spawnSync(process.execPath, [codexScript, "--version"], { encoding: "utf8" }).stdout.trim());

function stop(child) {
  if (process.platform !== "win32" || !child.pid) return void child.kill();
  spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
}

function listHooks(label, { codexHome, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [codexScript, "app-server"], {
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome, RUST_LOG: "warn" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      stop(child);
      resolve({ label, ...result, stderr: stderr.trim().slice(-600) });
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      buffer += chunk;
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 0) {
          if (message.error) return finish({ initializeError: message.error });
          send({ method: "initialized" });
          send({ id: 1, method: "hooks/list", params: { cwds: [cwd] } });
        } else if (message.id === 1) {
          finish(message.error ? { error: message.error } : { data: message.result?.data ?? message.result });
        }
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish({ spawnError: String(error) }));
    child.once("exit", (code) => finish({ exitedBeforeAnswering: code }));
    setTimeout(() => finish({ timedOutAfterMs: 60_000 }), 60_000).unref();
    send({ id: 0, method: "initialize", params: { capabilities: { experimentalApi: true }, clientInfo: { name: "video-fs-probe", title: null, version: "0.0.0" } } });
  });
}

function report(result) {
  const { data, ...rest } = result;
  const entries = Array.isArray(data) ? data : [];
  console.log(`\n=== ${result.label}`);
  if (!Array.isArray(data)) console.log(JSON.stringify(rest, null, 1));
  for (const entry of entries) {
    console.log(`hooks loaded: ${entry.hooks?.length ?? "?"}`);
    for (const hook of entry.hooks ?? []) console.log(JSON.stringify({ event: hook.eventName, handler: hook.handler, source: hook.source, sourcePath: hook.sourcePath, trust: hook.trustStatus }, null, 1));
    console.log("warnings:", JSON.stringify(entry.warnings, null, 1));
    console.log("errors:", JSON.stringify(entry.errors, null, 1));
  }
  if (rest.stderr) console.log("stderr tail:", rest.stderr);
}

const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "video-fs-codex-hooks-")));
const dataRoot = path.join(base, "projects");
const projectId = "codex-hooks-probe";
const projectRoot = path.join(dataRoot, projectId);
await mkdir(projectRoot, { recursive: true });
await writeFile(path.join(projectRoot, "project.json"), `${JSON.stringify({ id: projectId, name: "Codex hooks probe" })}\n`);
await setupAgentProject({
  projectId,
  state: {
    appUrl: "http://127.0.0.1:3210",
    dataRoot,
    mcp: { args: [path.join(base, "main.mjs"), "--mcp"], command: process.execPath },
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: "codex-hooks-probe-private-token-000000000000",
  },
});
const hooksPath = path.join(projectRoot, ".codex", "hooks.json");
const asWritten = await readFile(hooksPath, "utf8");
const hooksOnly = `${JSON.stringify({ hooks: JSON.parse(asWritten).hooks }, null, 2)}\n`;
console.log(`the app wrote ${hooksPath}:\n${asWritten}`);

async function home(name, files) {
  const directory = path.join(base, name);
  await mkdir(directory, { recursive: true });
  for (const [file, contents] of Object.entries(files)) await writeFile(path.join(directory, file), contents);
  return directory;
}
const trusted = `[projects.${JSON.stringify(projectRoot)}]\ntrust_level = "trusted"\n`;
const elsewhere = path.join(base, "elsewhere");
await mkdir(elsewhere, { recursive: true });

report(await listHooks("project file exactly as the app writes it, project trusted", { codexHome: await home("home-1", { "config.toml": trusted }), cwd: projectRoot }));
await writeFile(hooksPath, hooksOnly);
report(await listHooks("project file holding only the hooks key, project trusted", { codexHome: await home("home-2", { "config.toml": trusted }), cwd: projectRoot }));
await writeFile(hooksPath, asWritten);
report(await listHooks("the same text as a user-level hooks.json", { codexHome: await home("home-3", { "hooks.json": asWritten }), cwd: elsewhere }));
report(await listHooks("only the hooks key as a user-level hooks.json", { codexHome: await home("home-4", { "hooks.json": hooksOnly }), cwd: elsewhere }));
