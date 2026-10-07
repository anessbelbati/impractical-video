// Probe, run by Node: the real Codex takes one prompt in a project the app prepared, with a
// stand-in for the model server so that no account is needed. Shows whether Codex runs the app's
// hook, which shell it starts it through, and which ways of writing a command that shell accepts.
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { appProject, prompt, recorderHooks, recorderLog } from "./hook-lab.mjs";

const npmRoot = spawnSync("npm root -g", { encoding: "utf8", shell: true }).stdout.trim();
const codexScript = path.join(npmRoot, "@openai", "codex", "bin", "codex.js");
console.log("codex:", spawnSync(process.execPath, [codexScript, "--version"], { encoding: "utf8" }).stdout.trim());

async function modelServer() {
  const requests = [];
  const answer = [
    { response: { id: "resp-1" }, type: "response.created" },
    { item: { content: [{ text: "Stand-in answer.", type: "output_text" }], id: "msg-1", role: "assistant", type: "message" }, type: "response.output_item.done" },
    { response: { id: "resp-1", usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } }, type: "response.completed" },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ body, method: request.method, url: request.url });
    if (request.method === "POST" && request.url.split("?")[0].endsWith("/responses")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      return response.end(answer);
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

function appServer({ codexHome, cwd, env }) {
  const child = spawn(process.execPath, [codexScript, "app-server"], {
    cwd,
    env: { ...process.env, ...env, CODEX_HOME: codexHome, RUST_LOG: "warn" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map();
  const notifications = [];
  const watchers = new Set();
  let buffer = "";
  let stderr = "";
  let nextId = 0;
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.on("error", () => {});
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
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
      if (message.id !== undefined && waiting.has(message.id) && !message.method) {
        waiting.get(message.id)(message);
        waiting.delete(message.id);
      } else if (message.method && message.id !== undefined) {
        // A question from Codex to its client. Nothing here should ask one.
        notifications.push({ method: `QUESTION ${message.method}`, params: message.params });
        send({ error: { code: -32601, message: "The probe answers no questions." }, id: message.id });
      } else if (message.method) {
        notifications.push(message);
        for (const watcher of watchers) watcher(message);
      }
    }
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return {
    notifications,
    notify: (method, params) => send({ method, params }),
    request(method, params, ms = 60_000) {
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiting.delete(id); resolve({ error: { message: `no answer to ${method} after ${ms} ms` } }); }, ms);
        waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
        send({ id, method, params });
      });
    },
    stderrTail: () => stderr.trim().split("\n").filter((line) => !/bubblewrap|PATH aliases/.test(line)).slice(-12).join("\n"),
    async stop() {
      if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      else child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    },
    until(predicate, ms) {
      const found = notifications.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => {
        const watcher = (message) => {
          if (!predicate(message)) return;
          clearTimeout(timer);
          watchers.delete(watcher);
          resolve(message);
        };
        const timer = setTimeout(() => { watchers.delete(watcher); resolve(null); }, ms);
        watchers.add(watcher);
      });
    },
  };
}

const project = await appProject("codex-runs-hooks");
const model = await modelServer();
const hooksPath = path.join(project.projectRoot, ".codex", "hooks.json");
const asTheAppWritesIt = await readFile(hooksPath, "utf8");
let homes = 0;

/** A Codex home that knows only the stand-in model server and trusts the project folder. */
async function home() {
  const codexHome = path.join(project.base, `codex-home-${++homes}`);
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, "config.toml"), [
    'model = "mock-model"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'model_provider = "mock_provider"',
    "",
    "[model_providers.mock_provider]",
    'name = "Stand-in model server"',
    `base_url = "${model.url}/v1"`,
    'wire_api = "responses"',
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "supports_websockets = false",
    "",
    `[projects.${JSON.stringify(project.projectRoot)}]`,
    'trust_level = "trusted"',
    "",
  ].join("\n"));
  project.calls.length = 0;
  model.requests.length = 0;
  return codexHome;
}

function whatReachedWhom() {
  console.log("what the app's stand-in was asked:", JSON.stringify(project.calls));
  const asked = model.requests.filter((request) => request.method === "POST");
  console.log(`requests to the stand-in model server: ${asked.length}; the app's context was in ${asked.filter((request) => request.body.includes("video-fs-context")).length} of them; a stand-in hook's line was in ${asked.filter((request) => /recorder [a-z-]+\/[a-z-]+ ran/.test(request.body)).length}`);
  const tools = [...new Set(asked.flatMap((request) => {
    try {
      return (JSON.parse(request.body).tools ?? []).map((tool) => tool.name ?? tool.type);
    } catch {
      return [];
    }
  }))];
  const appTools = tools.filter((name) => /video[-_]fs/i.test(String(name)));
  console.log(`tools Codex offered the model: ${tools.length}; of the app: ${appTools.length}${appTools.length ? ` (${appTools.slice(0, 4).join(", ")}, ...)` : ` (all names: ${tools.slice(0, 12).join(", ")})`}`);
}

/** One prompt through the app server, the part of Codex its own windows talk to. `approve` skips
 * the question Codex asks a person before it runs a project's hook for the first time. */
async function onePrompt(title, { approve = true } = {}) {
  console.log(`\n=== ${title}`);
  console.log(`.codex/hooks.json:\n${(await readFile(hooksPath, "utf8")).trim()}`);
  const codexHome = await home();
  const server = appServer({ codexHome, cwd: project.projectRoot, env: { VIDEO_FS_DESKTOP_STATE_FILE: project.statePath } });
  try {
    const hello = await server.request("initialize", { capabilities: { experimentalApi: true }, clientInfo: { name: "video-fs-probe", title: null, version: "0.0.0" } });
    if (hello.error) return console.log("initialize failed:", JSON.stringify(hello.error));
    server.notify("initialized");
    const listed = await server.request("hooks/list", { cwds: [project.projectRoot] });
    for (const entry of listed.result?.data ?? []) {
      console.log(`hooks Codex loaded: ${entry.hooks?.length ?? "?"}`);
      for (const hook of entry.hooks ?? []) console.log(" ", JSON.stringify(hook));
      if (entry.warnings?.length) console.log("warnings:", JSON.stringify(entry.warnings));
      if (entry.errors?.length) console.log("errors:", JSON.stringify(entry.errors));
    }
    if (listed.error) console.log("hooks/list failed:", JSON.stringify(listed.error));

    // The setting the Codex project's own tests use to run a hook nobody has approved by hand.
    const thread = await server.request("thread/start", { ...(approve ? { config: { bypass_hook_trust: true } } : {}), cwd: project.projectRoot, ephemeral: true, model: "mock-model" });
    if (thread.error) return console.log("thread/start failed:", JSON.stringify(thread.error));
    const turn = await server.request("turn/start", { input: [{ text: prompt, type: "text" }], threadId: thread.result.thread.id });
    if (turn.error) return console.log("turn/start failed:", JSON.stringify(turn.error));
    const end = await server.until((message) => message.method === "turn/completed", 120_000);
    console.log("the turn:", end ? JSON.stringify(end.params?.turn?.status ?? end.params) : "did not finish within 120 seconds");
    const finished = server.notifications.filter((message) => message.method === "hook/completed");
    console.log(`hooks Codex started: ${server.notifications.filter((message) => message.method === "hook/started").length}, finished: ${finished.length}`);
    for (const { params } of finished) {
      const run = params?.run ?? {};
      console.log(" ", JSON.stringify({ event: run.eventName, status: run.status, ms: run.durationMs, message: run.statusMessage ?? undefined, said: (run.entries ?? []).map((entry) => `${entry.kind}: ${String(entry.text).slice(0, 300)}`) }));
    }
    for (const message of server.notifications.filter((item) => /^(error|QUESTION)/.test(item.method) || item.method === "warning")) {
      console.log(" ", message.method, JSON.stringify(message.params).slice(0, 400));
    }
    whatReachedWhom();
  } finally {
    await server.stop();
    const tail = server.stderrTail();
    if (tail) console.log("codex stderr, last lines:\n" + tail);
  }
}

/** The same prompt through `codex exec`, the command a person can type. */
async function execPrompt(title) {
  console.log(`\n=== ${title}`);
  const codexHome = await home();
  const started = Date.now();
  const result = await new Promise((resolve) => {
    // The flag Codex's own test of this command uses to run a hook nobody has approved by hand.
    const child = spawn(process.execPath, [codexScript, "exec", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", prompt], {
      cwd: project.projectRoot,
      env: { ...process.env, CODEX_HOME: codexHome, RUST_LOG: "warn", VIDEO_FS_DESKTOP_STATE_FILE: project.statePath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      else child.kill("SIGKILL");
    }, 120_000);
    child.once("error", (error) => { clearTimeout(timer); resolve({ code: `could not start: ${error}`, stderr, stdout }); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code: code ?? `signal ${signal}`, stderr, stdout }); });
  });
  console.log(`codex exec ended with ${result.code} after ${Date.now() - started} ms`);
  console.log("it printed:", result.stdout.trim().slice(-300) || "(nothing)");
  const tail = result.stderr.trim().split("\n").filter((line) => !/bubblewrap|PATH aliases/.test(line)).slice(-14).join("\n");
  if (tail) console.log("on its error stream, last lines:\n" + tail);
  whatReachedWhom();
}

async function whichRecordersRan(recorders) {
  const log = await recorderLog(recorders.logPath);
  console.log(`\nstand-in hooks that really ran: ${log.length} of ${recorders.handlers.length}`);
  for (const entry of log) console.log(JSON.stringify(entry));
  const ran = new Set(log.map((entry) => entry.label));
  console.log("never ran:", JSON.stringify(recorders.handlers.map((handler) => handler.command.split(" ").at(-1)).filter((label) => !ran.has(label))));
  await rm(recorders.logPath, { force: true });
}

const parsed = JSON.parse(asTheAppWritesIt);
const withOldCommand = structuredClone(parsed);
withOldCommand.hooks.UserPromptSubmit[0].hooks[0].command = project.oldCommand("codex");

try {
  await onePrompt("1. The project exactly as the app sets it up");
  await execPrompt("1b. The same project through codex exec");
  await onePrompt("1c. The same project when nobody has approved the hook inside Codex yet", { approve: false });

  await writeFile(hooksPath, `${JSON.stringify({ enableAllProjectMcpServers: true, enabledMcpjsonServers: ["video-fs"], ...withOldCommand }, null, 2)}\n`);
  await onePrompt("2. The hooks file as the app wrote it before this change");

  await writeFile(hooksPath, `${JSON.stringify(withOldCommand, null, 2)}\n`);
  await onePrompt("3. Only the two extra lines removed, the command still written the old way");

  const recorders = await recorderHooks(project.base);
  await writeFile(hooksPath, `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: recorders.handlers }] } }, null, 2)}\n`);
  await onePrompt("4. Stand-in hooks, one per way of writing the command");
  await whichRecordersRan(recorders);
  await execPrompt("4b. The same stand-in hooks through codex exec");
  await whichRecordersRan(recorders);
} finally {
  await writeFile(hooksPath, asTheAppWritesIt);
  await model.close();
  await project.close();
}
