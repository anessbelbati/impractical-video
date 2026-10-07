// Probe, run by Node on Windows: Codex starts a hook as `<PowerShell> -NoProfile -Command <command>`
// and writes the hook input to PowerShell's standard input. Shows, byte for byte, what the program
// named in <command> then receives and how its output arrives, in both PowerShells, for the two
// ways of writing the command, under the machine's own code page and under a Japanese one.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (process.platform !== "win32") {
  console.log("Windows only: nothing measured.");
  process.exit(0);
}

const base = await mkdtemp(path.join(os.tmpdir(), "video-fs-powershell-pipes-"));
const echo = path.join(base, "it's a folder", "echo.mjs");
await mkdir(path.dirname(echo), { recursive: true });
// Reports the bytes it was sent as hex, then a fixed text with letters outside ASCII and a lone
// line feed, with no line ending after it.
const fixed = "fixed: é ü 日本 ✓|";
await writeFile(echo, [
  "const chunks = [];",
  "const done = (state) => {",
  "  process.stdout.write(JSON.stringify({ state, hex: Buffer.concat(chunks).toString('hex') }) + '\\n' + " + JSON.stringify(fixed) + ");",
  "  process.exit(0);",
  "};",
  "process.stdin.on('data', (chunk) => chunks.push(chunk));",
  "process.stdin.on('end', () => done('ended'));",
  "process.stdin.on('error', (error) => done('error ' + error.code));",
  "setTimeout(() => done('still open after 8 seconds'), 8000);",
  "",
].join("\n"));

const input = Buffer.from(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Probe prompt: é ü 日本 ✓", session_id: "s" }), "utf8");
const quote = (word) => `'${word.replaceAll("'", "''")}'`;
const call = `& ${quote(process.execPath)} ${quote(echo)}`;
const forms = {
  "& <program>": call,
  "$input | & <program>": `$input | ${call}`,
};

const shells = [["Windows PowerShell", path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")]];
const pwsh = spawnSync("where.exe", ["pwsh"], { encoding: "utf8" }).stdout.split(/\r?\n/).filter(Boolean)[0]
  ?? ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"].find((candidate) => existsSync(candidate));
if (pwsh) shells.push(["PowerShell 7", pwsh]);
else console.log("PowerShell 7 (pwsh) was not found: only Windows PowerShell is measured.");

function run(shell, command, { ownConsole }) {
  return new Promise((resolve) => {
    const started = Date.now();
    // Codex starts a hook with no window of its own, which gives it a fresh console.
    const child = spawn(shell, ["-NoProfile", "-Command", command], { stdio: ["pipe", "pipe", "pipe"], windowsHide: ownConsole });
    const out = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }), 30_000);
    child.once("error", (error) => { clearTimeout(timer); resolve({ code: `could not start: ${error}`, ms: Date.now() - started, stderr, stdout: Buffer.concat(out) }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, ms: Date.now() - started, stderr, stdout: Buffer.concat(out) }); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function codePage() {
  const result = spawnSync("chcp.com", [], { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
  return (result.stdout.match(/\d+/) ?? [`unknown (${(result.stdout + result.stderr).trim() || "no console"})`])[0];
}

async function round(title, options) {
  console.log(`\n=== ${title}`);
  for (const [name, shell] of shells) {
    const facts = await run(shell, "'version ' + $PSVersionTable.PSVersion + '; reads input as code page ' + [Console]::InputEncoding.CodePage + '; writes output as ' + [Console]::OutputEncoding.CodePage + '; hands text to programs as ' + $OutputEncoding.CodePage", options);
    console.log(`${name}: ${facts.stdout.toString("utf8").trim() || `(no answer, ended with ${facts.code}) ${facts.stderr.trim().slice(0, 300)}`}`);
    for (const [form, command] of Object.entries(forms)) {
      const result = await run(shell, command, options);
      const text = result.stdout.toString("utf8");
      const firstLine = text.split(/\r?\n/)[0];
      let report = null;
      try {
        report = JSON.parse(firstLine);
      } catch { /* Shown below as unreadable. */ }
      const expected = Buffer.concat([Buffer.from(`${firstLine}\n`, "utf8"), Buffer.from(fixed, "utf8")]);
      console.log(`  ${form}: ended with ${result.code} after ${result.ms} ms`);
      if (!report) {
        console.log(`    the program's report could not be read: ${JSON.stringify(text.slice(0, 300))}`);
      } else {
        const received = Buffer.from(report.hex, "hex");
        console.log(`    standard input (${report.state}): ${received.equals(input) ? `intact, ${received.length} bytes` : received.length === 0 ? "NOTHING arrived" : `CHANGED, ${received.length} bytes against ${input.length} sent: ${JSON.stringify(received.toString("utf8"))}`}`);
        console.log(`    its output: ${result.stdout.equals(expected) ? "intact" : `CHANGED: ${JSON.stringify(text.slice(firstLine.length))} (hex ${result.stdout.subarray(Buffer.byteLength(firstLine)).toString("hex")}) against ${JSON.stringify(`\n${fixed}`)}`}`);
      }
      if (result.stderr.trim()) console.log(`    on the error stream: ${result.stderr.trim().slice(0, 400)}`);
    }
  }
}

const before = codePage();
console.log(`Node ${process.version}; this console's code page: ${before}`);
console.log(`sent on standard input: ${input.length} bytes, ${JSON.stringify(input.toString("utf8"))}`);
await round("A fresh console, as a hook started by Codex has", { ownConsole: true });
await round(`This console, code page ${before}`, { ownConsole: false });
if (/^\d+$/.test(before)) {
  try {
    const changed = spawnSync("chcp.com", ["932"], { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
    if (codePage() === "932") {
      await round("This console switched to code page 932, as on a Japanese Windows", { ownConsole: false });
    } else {
      console.log(`\nThe console could not be switched to code page 932 (${(changed.stdout + changed.stderr).trim()}): that part is not measured.`);
    }
  } finally {
    spawnSync("chcp.com", [before], { stdio: ["inherit", "ignore", "ignore"] });
  }
}
