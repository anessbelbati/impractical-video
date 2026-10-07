// Probe, run by Electron: each step the context hook takes, one at a time, with its own error.
import { realpath } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { readPrivateConnectionState } from "../../desktop/connection-state.mjs";
import { deriveProjectBearerToken } from "../../desktop/project-binding.mjs";

const statePath = process.env.PROBE_STATE;
const projectId = process.env.PROBE_PROJECT;
const cwd = process.env.PROBE_CWD;
const out = { platform: process.platform, electron: process.versions.electron, node: process.versions.node };

async function step(name, action) {
  try {
    out[name] = await action();
  } catch (error) {
    out[name] = {
      cause: error?.cause ? `${error.cause?.code ?? ""} ${error.cause?.message ?? error.cause}` : undefined,
      code: error?.code,
      error: String(error?.message ?? error),
    };
  }
}

let state = null;
await step("recordWithoutPidCheck", async () => {
  state = await readPrivateConnectionState(statePath, { requireLivePid: false });
  return { appUrl: state.appUrl, pid: state.pid };
});
await step("recordWithPidCheck", async () => {
  await readPrivateConnectionState(statePath);
  return "ok";
});
await step("signalZero", async () => {
  process.kill(Number(process.env.PROBE_PID), 0);
  return "alive";
});
await step("paths", async () => {
  const root = await realpath(path.resolve(state.dataRoot));
  const projectRoot = await realpath(path.join(root, projectId));
  const resolvedCwd = await realpath(cwd);
  return { dirnameMatches: path.dirname(projectRoot) === root, relative: path.relative(projectRoot, resolvedCwd) };
});
await step("request", async () => {
  const response = await fetch(`${state.appUrl}/api/paper/tools`, {
    body: JSON.stringify({ arguments: { projectId }, tool: "get_agent_context" }),
    headers: {
      authorization: `Bearer ${deriveProjectBearerToken(state.token, state.dataRoot, projectId)}`,
      "content-type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(4_000),
  });
  return { bodyStart: (await response.text()).slice(0, 80), status: response.status };
});

process.stdout.write(`${JSON.stringify(out)}\n`);
app.exit(0);
