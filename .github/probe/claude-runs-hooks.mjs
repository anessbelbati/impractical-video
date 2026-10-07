// Probe, run by Node: the real Claude Code takes one prompt in a project the app prepared, with a
// stand-in for the model server so that no account is needed. Shows whether Claude Code runs the
// app's hook and reaches the app's tools, which shell it starts the hook through, and which ways
// of writing a command that shell accepts.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { appProject, prompt, recorderHooks, recorderLog } from "./hook-lab.mjs";

function findClaude() {
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  // Where the installer the app runs puts it.
  const installed = path.join(os.homedir(), ".local", "bin", name);
  if (existsSync(installed)) return installed;
  const found = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8" }).stdout.split(/\r?\n/).filter(Boolean);
  return found.find((candidate) => !/\.cmd$/i.test(candidate)) ?? found[0] ?? null;
}

const claude = findClaude();
if (!claude) {
  console.log("Claude Code is not installed on this machine: nothing measured.");
  process.exit(1);
}
const startsThroughShell = /\.(cmd|bat)$/i.test(claude);
console.log("claude:", claude, (startsThroughShell ? spawnSync(`"${claude}" --version`, { encoding: "utf8", shell: true }) : spawnSync(claude, ["--version"], { encoding: "utf8" })).stdout?.trim());
console.log("Git Bash:", process.platform === "win32" ? (spawnSync("where.exe", ["bash"], { encoding: "utf8" }).stdout.trim().split(/\r?\n/).join(" | ") || "not on the search path") : "(not Windows)", "| CLAUDE_CODE_GIT_BASH_PATH:", process.env.CLAUDE_CODE_GIT_BASH_PATH ?? "(not set)");

async function modelServer() {
  const requests = [];
  const stream = (model) => [
    ["message_start", { message: { content: [], id: "msg_probe", model, role: "assistant", stop_reason: null, stop_sequence: null, type: "message", usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 1, output_tokens: 1 } } }],
    ["content_block_start", { content_block: { text: "", type: "text" }, index: 0 }],
    ["content_block_delta", { delta: { text: "Stand-in answer.", type: "text_delta" }, index: 0 }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }],
    ["message_stop", {}],
  ].map(([type, fields]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`).join("");
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch { /* Not every request carries JSON. */ }
    const route = request.url.split("?")[0];
    requests.push({ body, method: request.method, route, tools: (payload.tools ?? []).map((tool) => tool.name) });
    if (request.method === "POST" && route.endsWith("/messages/count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ input_tokens: 10 }));
    }
    if (request.method === "POST" && route.endsWith("/messages")) {
      const model = payload.model ?? "stand-in";
      if (payload.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        return response.end(stream(model));
      }
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ content: [{ text: "Stand-in answer.", type: "text" }], id: "msg_probe", model, role: "assistant", stop_reason: "end_turn", stop_sequence: null, type: "message", usage: { input_tokens: 1, output_tokens: 3 } }));
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

const project = await appProject("claude-runs-hooks");
const model = await modelServer();
const settingsPath = path.join(project.projectRoot, ".claude", "settings.json");
const asTheAppWritesIt = await readFile(settingsPath, "utf8");
let homes = 0;

async function onePrompt(title) {
  console.log(`\n=== ${title}`);
  console.log(`.claude/settings.json:\n${(await readFile(settingsPath, "utf8")).trim()}`);
  const configFolder = path.join(project.base, `claude-home-${++homes}`);
  await mkdir(configFolder, { recursive: true });
  // The folder counts as one the user already said yes to, as it would after the first question.
  const accepted = { hasCompletedProjectOnboarding: true, hasTrustDialogAccepted: true };
  await writeFile(path.join(configFolder, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true,
    projects: { [project.projectRoot]: accepted, [project.projectRoot.replaceAll("\\", "/")]: accepted },
  }));
  project.calls.length = 0;
  model.requests.length = 0;
  const env = {
    ...process.env,
    // Only the stand-in server ever sees this value.
    ANTHROPIC_API_KEY: "video-fs-probe-placeholder",
    ANTHROPIC_BASE_URL: model.url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CONFIG_DIR: configFolder,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_TELEMETRY: "1",
    MCP_TIMEOUT: "20000",
    VIDEO_FS_DESKTOP_STATE_FILE: project.statePath,
  };
  for (const key of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDECODE"]) delete env[key];
  const started = Date.now();
  const result = await new Promise((resolve) => {
    // A launcher written by a package manager only starts through cmd.exe, which wants its own quotes.
    const words = ["-p", prompt, "--output-format", "json"];
    const child = startsThroughShell
      ? spawn(`"${claude}" ${words.map((word) => `"${word}"`).join(" ")}`, { cwd: project.projectRoot, env, shell: true, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(claude, words, { cwd: project.projectRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      else child.kill("SIGKILL");
    }, 150_000);
    child.once("error", (error) => { clearTimeout(timer); resolve({ code: `could not start: ${error}`, stderr, stdout }); });
    child.once("exit", (code, signal) => { clearTimeout(timer); setTimeout(() => resolve({ code: code ?? `signal ${signal}`, stderr, stdout }), 300); });
  });
  console.log(`claude -p ended with ${result.code} after ${Date.now() - started} ms`);
  console.log("it printed:", result.stdout.trim().slice(0, 700) || "(nothing)");
  if (result.stderr.trim()) console.log("on its error stream:", result.stderr.trim().slice(-700));
  console.log("what the app's stand-in was asked:", JSON.stringify(project.calls));
  const asked = model.requests.filter((request) => request.method === "POST" && request.route.endsWith("/messages"));
  console.log(`requests to the stand-in model server: ${asked.length}; the app's context was in ${asked.filter((request) => request.body.includes("video-fs-context")).length} of them; a stand-in hook's line was in ${asked.filter((request) => /recorder [a-z-]+\/[a-z-]+(\+shell-field)? ran/.test(request.body)).length}`);
  const appTools = [...new Set(asked.flatMap((request) => request.tools).filter((name) => name.startsWith("mcp__")))];
  console.log(`tools of the app that Claude Code offered the model: ${appTools.length}${appTools.length ? ` (${appTools.slice(0, 6).join(", ")}${appTools.length > 6 ? ", ..." : ""})` : ""}`);
  console.log("other addresses it asked:", JSON.stringify([...new Set(model.requests.filter((request) => !request.route.endsWith("/messages")).map((request) => `${request.method} ${request.route}`))]));
}

try {
  await onePrompt("1. The project exactly as the app sets it up");

  if (process.platform === "win32") {
    // The app writes the Codex command for PowerShell. The same command for Claude Code, with the
    // hook itself naming PowerShell as its shell.
    const forCodex = JSON.parse(await readFile(path.join(project.projectRoot, ".codex", "hooks.json"), "utf8")).hooks.UserPromptSubmit[0].hooks[0];
    const settings = JSON.parse(asTheAppWritesIt);
    settings.hooks.UserPromptSubmit[0].hooks[0] = { ...forCodex, command: forCodex.command.replace("--agent codex", "--agent claude"), shell: "powershell" };
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    await onePrompt("1b. The app's hook written for PowerShell, the hook naming PowerShell as its shell");
  }

  const recorders = await recorderHooks(project.base);
  const handlers = [
    ...recorders.handlers,
    // The same PowerShell lines again, this time naming PowerShell in the hook's own "shell" field.
    ...recorders.handlers
      .filter((handler) => handler.command.startsWith("& "))
      .map((handler) => ({ ...handler, command: `${handler.command}+shell-field`, shell: "powershell" })),
  ];
  await writeFile(settingsPath, `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: handlers }] } }, null, 2)}\n`);
  await onePrompt("2. Stand-in hooks, one per way of writing the command");
  const log = await recorderLog(recorders.logPath);
  console.log(`\nstand-in hooks that really ran: ${log.length} of ${handlers.length}`);
  for (const entry of log) console.log(JSON.stringify(entry));
  const ran = new Set(log.map((entry) => entry.label));
  console.log("never ran:", JSON.stringify(handlers.map((handler) => handler.command.split(" ").at(-1)).filter((label) => !ran.has(label))));
} finally {
  await writeFile(settingsPath, asTheAppWritesIt);
  await model.close();
  await project.close();
}
