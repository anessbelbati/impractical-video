// Probe, run by Node from a PowerShell 7 step: does Windows PowerShell still find its own
// Get-FileHash when it inherits PowerShell 7's module path, and when that variable is removed?
import { spawnSync } from "node:child_process";
import path from "node:path";

const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const command = [
  "'version ' + $PSVersionTable.PSVersion.ToString()",
  "$found = Get-Command Get-FileHash -ErrorAction SilentlyContinue",
  "if ($found) { 'Get-FileHash: ' + $found.CommandType + ' from ' + $found.Source } else { 'Get-FileHash: NOT FOUND' }",
  "'module path seen: ' + $env:PSModulePath",
].join("; ");

function run(label, env) {
  const result = spawnSync(powershell, ["-NoProfile", "-Command", command], { encoding: "utf8", env });
  console.log(`--- ${label} (exit ${result.status})\n${result.stdout}${result.stderr}`);
}

const names = Object.keys(process.env).filter((name) => name.toUpperCase() === "PSMODULEPATH");
console.log("inherited:", names.length ? names.map((name) => `${name}=${process.env[name]}`).join("\n") : "(not set)");
run("with the inherited environment", process.env);
const without = { ...process.env };
for (const name of names) delete without[name];
run("without the variable", without);
