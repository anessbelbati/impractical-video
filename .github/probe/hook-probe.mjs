// Probe, run by Node: starts Electron the way the installed context hook is started and prints
// exactly what comes back, so a failure names its own cause.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { writePrivateConnectionState } from "../../desktop/connection-state.mjs";

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const mainPath = here("../../desktop/main.mjs");
const projectId = "hook-probe";
const token = "hook-probe-private-token-0000000000000000000";

function run(label, args, { delayMs = 0, env = {}, input, keepOpen = false } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(electron, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", (error) => { stderr += `\n[writing to its stdin failed: ${error.code}]`; });
    child.once("error", (error) => resolve({ label, spawnError: String(error) }));
    child.once("exit", (code, signal) => {
      setTimeout(() => resolve({ code, label, ms: Date.now() - started, signal, stderr: stderr.trim().slice(-600), stdout: stdout.trim().slice(0, 1600) }), 200);
    });
    if (keepOpen) child.stdin.write(input ?? "");
    else setTimeout(() => child.stdin.end(input ?? ""), delayMs);
    setTimeout(() => child.kill(), 30_000).unref();
  });
}

const directory = await mkdtemp(path.join(os.tmpdir(), "video-fs-hook-probe-"));
const dataRoot = path.join(directory, "projects");
const projectRoot = path.join(dataRoot, projectId);
const statePath = path.join(directory, "desktop-connection.json");
await mkdir(projectRoot, { recursive: true });
await writeFile(path.join(projectRoot, "project.json"), `${JSON.stringify({ id: projectId, name: "Hook probe" })}\n`);

const context = {
  activeView: "canvas",
  attachments: [],
  binding: { appSessionId: "app-session", windowId: "window-main" },
  canvas: { focused: null, pinned: [], selected: [] },
  clearEpoch: 0,
  contextRevision: 12,
  editor: { documentRevision: null, fps: null, playheadTicks: null, sceneId: null, selectedElements: [], selectedKeyframes: [], selectedMaskPoints: null, selectedTrackIds: [], timeRange: null },
  projectId,
  schema: "AgentContextSnapshot@1",
};
const calls = [];
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  let payload = {};
  try {
    payload = JSON.parse(body);
  } catch { /* A request without a JSON body is only counted. */ }
  calls.push(payload.tool ?? `${request.method} ${request.url}`);
  response.setHeader("content-type", "application/json");
  if (payload.tool === "get_agent_context") return response.end(JSON.stringify({ context, staleEntities: [] }));
  if (payload.tool !== "create_agent_turn_snapshot") return response.end("{}");
  response.end(JSON.stringify({ snapshot: { agent: "codex", agentSessionId: payload.arguments.agentSessionId, context, projectId, snapshotId: "turn_probe", turnId: payload.arguments.turnId, windowId: "window-main" } }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const appUrl = `http://127.0.0.1:${server.address().port}`;
await writePrivateConnectionState(statePath, { appUrl, dataRoot, mcp: { args: [mainPath, "--mcp"], command: electron }, pid: process.pid, startedAt: new Date().toISOString(), token });

const hookInput = JSON.stringify({ cwd: projectRoot, hook_event_name: "UserPromptSubmit", permission_mode: "default", session_id: "probe-session", turn_id: "probe-turn" });
const stdinProbe = [here("./electron-stdin.mjs")];
const greeting = "hello from the parent";
const results = [
  await run("process.stdin", stdinProbe, { input: greeting }),
  await run("process.stdin, written one second late", stdinProbe, { delayMs: 1000, input: greeting }),
  await run("descriptor 0 read in one go", stdinProbe, { env: { PROBE_STDIN_MODE: "sync" }, input: greeting }),
  await run("descriptor 0 as a file stream", stdinProbe, { env: { PROBE_STDIN_MODE: "fd-stream" }, input: greeting }),
  await run("descriptor 0 as a pipe socket", stdinProbe, { env: { PROBE_STDIN_MODE: "socket" }, input: greeting }),
  await run("the fix's reader", stdinProbe, { env: { PROBE_STDIN_MODE: "helper" }, input: greeting }),
  await run("the fix's reader, written one second late", stdinProbe, { delayMs: 1000, env: { PROBE_STDIN_MODE: "helper" }, input: greeting }),
  await run("the fix's reader, leaving while the parent keeps the pipe open", stdinProbe, { env: { PROBE_STDIN_MODE: "helper-exit" }, input: greeting, keepOpen: true }),
  await run("the hook's steps one at a time", [here("./electron-hook-steps.mjs")], { env: { PROBE_CWD: projectRoot, PROBE_PID: String(process.pid), PROBE_PROJECT: projectId, PROBE_STATE: statePath } }),
  await run("the real hook", [mainPath, "--agent-context-hook", "--agent", "codex", "--project-id", projectId], { env: { VIDEO_FS_DESKTOP_STATE_FILE: statePath }, input: hookInput }),
];
for (const result of results) console.log(JSON.stringify(result, null, 1));
console.log("requests the local server received:", calls);
server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
