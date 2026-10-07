// Probe helpers: a project prepared by the app's own setup with a stand-in for the running app
// behind it, and stand-in hooks written in every way a command line can be quoted.
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { setupAgentProject } from "../../desktop/agent-setup.mjs";
import { writePrivateConnectionState } from "../../desktop/connection-state.mjs";

export const here = (name) => fileURLToPath(new URL(name, import.meta.url));
export const prompt = "Probe prompt with letters outside ASCII: é ü 日本";
const mainPath = here("../../desktop/main.mjs");
const token = "hook-lab-private-token-000000000000000000000";

/** Where the installed hook looks when the agent does not pass the probe's variable on to it. */
function defaultStatePath() {
  const folder = process.platform === "win32"
    ? process.env.APPDATA
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(folder, "Video FS", "desktop-connection.json");
}

export async function appProject(projectId) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "video-fs-hook-lab-")));
  const dataRoot = path.join(base, "projects");
  const projectRoot = path.join(dataRoot, projectId);
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "project.json"), `${JSON.stringify({ id: projectId, name: "Hook lab" })}\n`);

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
    calls.push(payload.tool ? `${payload.tool}${payload.arguments?.agent ? ` (agent ${payload.arguments.agent})` : ""}` : `${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (payload.tool === "get_agent_context") return response.end(JSON.stringify({ context, staleEntities: [] }));
    if (payload.tool !== "create_agent_turn_snapshot") return response.end("{}");
    response.end(JSON.stringify({ snapshot: { agent: payload.arguments.agent, agentSessionId: payload.arguments.agentSessionId, context, projectId, snapshotId: "turn_lab", turnId: payload.arguments.turnId, windowId: "window-main" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const state = { appUrl: `http://127.0.0.1:${server.address().port}`, dataRoot, mcp: { args: [mainPath, "--mcp"], command: electron }, pid: process.pid, startedAt: new Date().toISOString(), token };
  const statePath = path.join(base, "desktop-connection.json");
  const fallbackStatePath = defaultStatePath();
  await mkdir(path.dirname(fallbackStatePath), { recursive: true });
  await writePrivateConnectionState(statePath, state);
  await writePrivateConnectionState(fallbackStatePath, state);
  const setup = await setupAgentProject({ projectId, state });
  return {
    base,
    calls,
    /** The app's hook command as it was written before this change, for every shell alike. */
    oldCommand: (agent) => [electron, mainPath, "--agent-context-hook", "--agent", agent, "--project-id", projectId].map(posixQuote).join(" "),
    projectRoot,
    setup,
    statePath,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(fallbackStatePath, { force: true });
    },
  };
}

function posixQuote(word) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\"'\"'")}'`;
}

/** One stand-in hook per way of writing a command line, each also with a script in a folder whose
 * name holds a space and an apostrophe. Returns hook handlers and the log they write. */
export async function recorderHooks(base) {
  const plain = path.join(base, "hook-recorder.mjs");
  const awkward = path.join(base, "it's a folder", "hook-recorder.mjs");
  await mkdir(path.dirname(awkward), { recursive: true });
  await copyFile(here("./hook-recorder.mjs"), plain);
  await copyFile(here("./hook-recorder.mjs"), awkward);
  const node = process.execPath;
  const forms = {
    "no-quotes": (script) => [node, script].join(" "),
    "posix-quotes": (script) => [node, script].map(posixQuote).join(" "),
    "double-quotes": (script) => [node, script].map((word) => `"${word}"`).join(" "),
    ...(process.platform === "win32"
      ? {
          "powershell-call": (script) => `& ${[node, script].map((word) => `'${word.replaceAll("'", "''")}'`).join(" ")}`,
          "powershell-call-fed-input": (script) => `$input | & ${[node, script].map((word) => `'${word.replaceAll("'", "''")}'`).join(" ")}`,
        }
      : {}),
  };
  const handlers = [];
  for (const [form, write] of Object.entries(forms)) {
    for (const [where, script] of [["plain-path", plain], ["awkward-path", awkward]]) {
      // A path with a space cannot be written without quotes at all.
      if (form === "no-quotes" && where === "awkward-path") continue;
      const label = `${form}/${where}`;
      handlers.push({ command: `${write(script)} ${label}`, timeout: 30, type: "command" });
    }
  }
  return { handlers, logPath: path.join(base, "hook-log.jsonl") };
}

export async function recorderLog(logPath) {
  const text = await readFile(logPath, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
