// Probe, run by Node: the app's tool server started with only the variables Codex hands an MCP
// server, without and with the display variables, and what it answers to the first MCP message.
import { spawn } from "node:child_process";
import electron from "electron";
import { appProject, here } from "./hook-lab.mjs";

// codex-rs/rmcp-client/src/utils.rs, DEFAULT_ENV_VARS for unix, at tag rust-v0.160.1.
const codexDefaults = ["HOME", "LOGNAME", "PATH", "SHELL", "USER", "__CF_USER_TEXT_ENCODING", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ"];
const display = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE"];
const projectId = "tool-server-env";
const project = await appProject(projectId);

function start(title, names) {
  const env = Object.fromEntries(names.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  console.log(`\n=== ${title}`);
  console.log(`variables handed over: ${Object.keys(env).length}; of the display ones: ${display.filter((name) => name in env).join(", ") || "none"}`);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(electron, [here("../../desktop/main.mjs"), "--mcp", "--project-id", projectId], { cwd: project.projectRoot, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (how) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      console.log(`${how} after ${Date.now() - started} ms`);
      let name = null;
      try {
        name = JSON.parse(stdout.split("\n")[0]).result?.serverInfo?.name ?? null;
      } catch { /* No whole answer line arrived. */ }
      console.log("the tool server named itself:", name ?? "(no answer)");
      const tail = stderr.trim().split("\n").filter(Boolean).slice(-6).join("\n");
      if (tail) console.log("on its error stream, last lines:\n" + tail);
      resolve();
    };
    const timer = setTimeout(() => finish("no answer and still running"), 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("\n")) finish("answered");
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(`could not start: ${error}`));
    child.once("close", (code, signal) => finish(`ended with ${code ?? `signal ${signal}`}`));
    child.stdin.on("error", () => {});
    child.stdin.write(`${JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize", params: { capabilities: {}, clientInfo: { name: "video-fs-probe", version: "0.0.0" }, protocolVersion: "2025-06-18" } })}\n`);
  });
}

try {
  await start("1. With every variable this job's shell has", Object.keys(process.env));
  await start("2. With only what Codex hands an MCP server", codexDefaults);
  await start("3. The same, plus the display variables the app now names for Codex", [...codexDefaults, ...display]);
} finally {
  await project.close();
}
