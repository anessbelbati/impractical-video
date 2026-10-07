import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { agentCliLaunch, commandShimTarget, localAgentCliEnv, resolveAgentBinary, resolveCommand } from "@/lib/agent-binaries";
import { agentConnectStatus, agentSignedIn, cancelAgentConnect, startAgentConnect, type ConnectAgent } from "@/lib/agent-connect";

// Work-in-progress probe, not part of the proposed change. It runs the real
// installers and CLIs, so it only runs on a throwaway CI machine that sets
// PROBE_REAL_AGENT_CLIS=1. Nobody signs in there.

const execFileAsync = promisify(execFile);
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
type Status = Awaited<ReturnType<typeof agentConnectStatus>>;

async function waitFor(agent: ConnectAgent, done: (status: Status) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await agentConnectStatus(agent);
    if (done(status) || Date.now() > deadline) return status;
    await sleep(2000);
  }
}

async function runThroughLaunch(file: string, args: string[]) {
  const environment = localAgentCliEnv();
  try {
    const launch = agentCliLaunch(file, args, environment);
    try {
      const { stdout, stderr } = await execFileAsync(launch.command, launch.args, {
        encoding: "utf8",
        env: environment,
        timeout: 60_000,
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      });
      return { command: launch.command, exit: 0, firstArgument: launch.args[0], stderr: stderr.trim().slice(0, 300), stdout: stdout.trim().slice(0, 300) };
    } catch (error) {
      const failure = error as { code?: number | string; message: string; stderr?: string; stdout?: string };
      return {
        command: launch.command,
        exit: failure.code,
        firstArgument: launch.args[0],
        message: failure.message.slice(0, 300),
        stderr: String(failure.stderr ?? "").trim().slice(0, 300),
        stdout: String(failure.stdout ?? "").trim().slice(0, 300),
      };
    }
  } catch (error) {
    return { refused: String(error) };
  }
}

async function connect(agent: ConnectAgent) {
  console.log(`[probe] ${agent} before`, { binary: await resolveAgentBinary(agent), signedIn: await agentSignedIn(agent) });
  const started = await startAgentConnect(agent);
  console.log(`[probe] ${agent} started`, started);
  const afterInstall = await waitFor(agent, (status) => status.stage !== "installing", 300_000);
  console.log(`[probe] ${agent} after install`, afterInstall);
  const binary = await resolveAgentBinary(agent);
  console.log(`[probe] ${agent} found at`, binary);
  if (binary) {
    console.log(`[probe] ${agent} --version`, await runThroughLaunch(binary, ["--version"]));
    console.log(`[probe] ${agent} with a prompt-like argument`, await runThroughLaunch(binary, ["--version", 'two words & "quotes"\nnext line']));
  }
  // Give the CLI time to print or open its sign-in address.
  await sleep(10_000);
  const waiting = await agentConnectStatus(agent);
  console.log(`[probe] ${agent} while waiting for the browser`, waiting);
  console.log(`[probe] ${agent} cancel`, cancelAgentConnect(agent));
  await sleep(4000);
  console.log(`[probe] ${agent} after cancel`, await agentConnectStatus(agent));
  return { afterInstall, binary, waiting };
}

describe.runIf(process.env.PROBE_REAL_AGENT_CLIS === "1")("real agent CLIs on this machine", () => {
  it("shows the search path the app uses", async () => {
    const environment = localAgentCliEnv();
    console.log("[probe] PATH tail", (environment.PATH ?? "").split(process.platform === "win32" ? ";" : ":").slice(-4));
    console.log("[probe] npm", await resolveCommand("npm", environment), "node", await resolveCommand("node", environment), "git", await resolveCommand("git", environment));
  });

  it("starts the launchers other package managers write", async () => {
    for (const file of (process.env.PROBE_LAUNCHERS ?? "").split(";").filter(Boolean)) {
      const text = await readFile(file, "utf8");
      console.log(`[probe] launcher ${file}\n${text}`);
      console.log("[probe] parsed", commandShimTarget(text));
      console.log("[probe] --version", await runThroughLaunch(file, ["--version"]));
      console.log("[probe] with a prompt-like argument", await runThroughLaunch(file, ["--version", 'two words & "quotes"\nnext line']));
    }
  }, 300_000);

  it("connects Codex: installs it, finds it, starts its sign-in and stops it", async () => {
    const { afterInstall, binary, waiting } = await connect("codex");
    expect(afterInstall.installed).toBe(true);
    expect(binary).not.toBeNull();
    expect(waiting.stage).toBe("awaiting_browser");
  }, 600_000);

  it("connects Claude Code: installs it, finds it, starts its sign-in and stops it", async () => {
    const { afterInstall, binary, waiting } = await connect("claude");
    expect(afterInstall.installed).toBe(true);
    expect(binary).not.toBeNull();
    expect(waiting.stage).toBe("awaiting_browser");
  }, 600_000);
});
