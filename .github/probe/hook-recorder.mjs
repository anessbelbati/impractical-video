// Probe: stands in for a hook. Writes down how it was started and what it was sent, then answers
// the way a hook answers. The log sits beside the first copy of this file.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const folder = path.dirname(self);
const logPath = path.join(path.basename(folder) === "it's a folder" ? path.dirname(folder) : folder, "hook-log.jsonl");
const label = process.argv[2] ?? "(no label)";

function startedBy() {
  try {
    if (process.platform === "win32") {
      const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${process.ppid}'; $g = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p.ParentProcessId); @{ parent = $p.CommandLine; grandparent = $g.CommandLine } | ConvertTo-Json -Compress`;
      const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return JSON.parse(result.stdout);
    }
    if (process.platform === "linux") {
      return { parent: readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ") };
    }
    return { parent: spawnSync("ps", ["-o", "command=", "-p", String(process.ppid)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).stdout.trim() };
  } catch (error) {
    return { parent: `unknown: ${error}` };
  }
}

const parents = startedBy();
let text = "";
const ending = await new Promise((resolve) => {
  try {
    process.stdin.setEncoding("utf8").on("data", (chunk) => { text += chunk; });
    process.stdin.once("end", () => resolve("ended"));
    process.stdin.once("error", (error) => resolve(`error ${error.code}`));
  } catch (error) {
    resolve(`could not be opened: ${error.code ?? error}`);
  }
  setTimeout(() => resolve("still open after 5 seconds"), 5000);
});
let input = null;
try {
  input = JSON.parse(text);
} catch { /* Recorded below as not being JSON. */ }
appendFileSync(logPath, `${JSON.stringify({
  label,
  arguments: process.argv.slice(2),
  workingFolder: process.cwd(),
  ...parents,
  standardInput: ending,
  standardInputBytes: Buffer.byteLength(text),
  standardInputIsJson: input !== null,
  inputKeys: input && typeof input === "object" ? Object.keys(input) : [],
  event: input?.hook_event_name ?? null,
  prompt: input?.prompt ?? input?.user_prompt ?? null,
  stateFileVariable: process.env.VIDEO_FS_DESKTOP_STATE_FILE ? "passed on" : "not passed on",
})}\n`);
process.stdout.write(`${JSON.stringify({ continue: true, hookSpecificOutput: { additionalContext: `recorder ${label} ran`, hookEventName: "UserPromptSubmit" } })}\n`);
process.exit(0);
