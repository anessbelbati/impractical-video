// Prints the platform facts the Windows work depends on, measured on the runner instead of assumed.
// Lives only on work-in-progress branches of this fork.
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const tmp = await mkdtemp(path.join(os.tmpdir(), "probe-facts-"));
const show = (value) => JSON.stringify(value);

async function section(title, body) {
  console.log(`\n== ${title} ==`);
  try {
    await body();
  } catch (error) {
    console.log(`SECTION FAILED: ${error?.stack || error}`);
  }
}

await section("platform", async () => {
  console.log("platform", process.platform, process.arch, "node", process.version);
  console.log("path keys in process.env:", show(Object.keys(process.env).filter((key) => /^path$/i.test(key))));
  for (const key of ["PATHEXT", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "SHELL"]) {
    console.log(`${key}=${show(process.env[key])}`);
  }
  console.log("homedir", show(os.homedir()), "tmpdir", show(os.tmpdir()));
  console.log('path.join("/usr/bin","claude") =>', show(path.join("/usr/bin", "claude")), "resolved", show(path.resolve("/usr/bin", "claude")));
  console.log('path.isAbsolute("/Applications/Video FS") =>', path.isAbsolute("/Applications/Video FS"));
});

await section("file modes", async () => {
  const file = path.join(tmp, "mode.txt");
  await writeFile(file, "x", { mode: 0o600 });
  await chmod(file, 0o600);
  const info = await stat(file);
  console.log("mode after writeFile(0o600)+chmod(0o600):", (info.mode & 0o777).toString(8), "uid", info.uid, "typeof getuid", typeof process.getuid);
  const directory = path.join(tmp, "mode-dir");
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  console.log("directory mode after mkdir(0o700)+chmod(0o700):", ((await stat(directory)).mode & 0o777).toString(8));
  try {
    await access(file, constants.X_OK);
    console.log("access(X_OK) on a plain text file: allowed");
  } catch (error) {
    console.log("access(X_OK) on a plain text file:", error.code);
  }
  await chmod(file, 0o000);
  console.log("mode after chmod(0o000):", ((await stat(file)).mode & 0o777).toString(8));
  try {
    await readFile(file, "utf8");
    console.log("read after chmod(0o000): allowed");
  } catch (error) {
    console.log("read after chmod(0o000):", error.code);
  }
  await chmod(file, 0o600);
});

function attempt(label, command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 20_000, ...options });
  console.log(
    `${label} => status ${result.status} signal ${result.signal} error ${result.error?.code ?? null}`,
    "stdout", show((result.stdout || "").trim().slice(0, 300)),
    "stderr", show((result.stderr || "").trim().slice(0, 300)),
  );
  return result;
}

await section("starting command shims", async () => {
  const directory = path.join(tmp, "shim dir");
  await mkdir(directory);
  const stub = path.join(directory, "tool");
  const batch = path.join(directory, "tool.cmd");
  await writeFile(stub, "#!/bin/sh\necho stub\n", { mode: 0o755 });
  await writeFile(batch, "@echo off\r\necho batch got: %*\r\n");
  attempt("extension-less sh stub, no shell", stub, ["a"]);
  attempt(".cmd, no shell", batch, ["a"]);
  attempt("bare npm, no shell", "npm", ["--version"]);
  attempt("npm.cmd, no shell", "npm.cmd", ["--version"]);
  attempt("bare git, no shell", "git", ["--version"]);
  attempt("bare node, no shell", "node", ["--version"]);
  attempt("bare python3, no shell", "python3", ["--version"]);
  attempt("bare python, no shell", "python", ["--version"]);
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    attempt(".cmd through cmd.exe /d /s /c, verbatim", comspec, ["/d", "/s", "/c", `""${batch}" plain --flag=1"`], { windowsVerbatimArguments: true });
    attempt("where npm", "where.exe", ["npm"]);
    attempt("where node", "where.exe", ["node"]);
    attempt("where python3", "where.exe", ["python3"]);
  }
});

await section("arguments reaching a real executable unchanged", async () => {
  const script = path.join(tmp, "echo-args.mjs");
  await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const tricky = ["line one\nline two", 'quote " and \\ backslash', "amp & pipe | caret ^ percent %PATH% bang !x!", "", "trailing\\", "{\"json\":true}"];
  const result = spawnSync(process.execPath, [script, ...tricky], { encoding: "utf8" });
  let received = null;
  try { received = JSON.parse(result.stdout); } catch { /* reported below */ }
  console.log("sent    ", show(tricky));
  console.log("received", show(received));
  console.log("identical:", show(received) === show(tricky));
});

await section("rename over a file that is being read", async () => {
  async function run(retry) {
    const directory = await mkdtemp(path.join(tmp, "rename-"));
    const target = path.join(directory, "task.json");
    await writeFile(target, show({ status: "queued" }));
    const errors = { write: {}, read: {}, retries: 0, longestWaitMs: 0 };
    const count = (bucket, code) => { bucket[code] = (bucket[code] || 0) + 1; };
    const publish = async (temporary) => {
      const started = Date.now();
      for (let tries = 0; ; tries += 1) {
        try {
          await rename(temporary, target);
          errors.longestWaitMs = Math.max(errors.longestWaitMs, Date.now() - started);
          return;
        } catch (error) {
          if (!retry || tries >= 19 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
          errors.retries += 1;
          await new Promise((resolve) => setTimeout(resolve, Math.min(5 * 2 ** tries, 100)));
        }
      }
    };
    const writer = async (worker) => {
      for (let revision = 0; revision < 300; revision += 1) {
        const temporary = path.join(directory, `.tmp-${worker}-${revision}`);
        await writeFile(temporary, show({ worker, revision, status: "running" }), { flag: "wx" });
        try {
          await publish(temporary);
        } catch (error) {
          count(errors.write, error.code);
          await rm(temporary, { force: true });
        }
      }
    };
    const reader = async () => {
      for (let index = 0; index < 3000; index += 1) {
        try {
          JSON.parse(await readFile(target, "utf8"));
        } catch (error) {
          count(errors.read, error.code || error.name);
        }
      }
    };
    await Promise.all([writer(0), writer(1), writer(2), reader(), reader()]);
    return errors;
  }
  console.log("900 renames + 6000 reads, no retry:  ", show(await run(false)));
  console.log("900 renames + 6000 reads, with retry:", show(await run(true)));
});

await section("how @next/env reads quoted paths", async () => {
  const nextEnv = (await import(pathToFileURL(path.join(root, "node_modules", "@next", "env", "dist", "index.js")).href)).default;
  const directory = path.join(tmp, "dotenv");
  await mkdir(directory);
  const windowsPath = "C:\\Users\\rita\\repos\\new\\data\\projects";
  const lines = [
    `PROBE_DQ_JSON=${JSON.stringify(windowsPath)}`,
    `PROBE_SQ='${windowsPath}'`,
    `PROBE_BARE=${windowsPath}`,
    `PROBE_FWD="${windowsPath.replaceAll("\\", "/")}"`,
    `PROBE_SQ_DOLLAR='C:\\Users\\a$b\\data'`,
    `PROBE_SQ_SPACE_HASH='C:\\Users\\a b #c\\data'`,
    "PROBE_BT=`C:\\Users\\O'Brien\\repos\\new`",
  ];
  await writeFile(path.join(directory, ".env.local"), `${lines.join("\n")}\n`);
  const { parsedEnv } = nextEnv.loadEnvConfig(directory, true, { info() {}, error: console.log }, true);
  console.log("wanted          ", show(windowsPath));
  for (const key of Object.keys(parsedEnv ?? {}).filter((name) => name.startsWith("PROBE_"))) {
    console.log(key.padEnd(20), show(parsedEnv[key]));
  }

  const { setupLocal } = await import(pathToFileURL(path.join(root, "scripts", "setup-local.mjs")).href);
  for (const name of ["plain", "repos", "next-app", "it's here"]) {
    const checkout = path.join(tmp, "checkouts", name);
    await mkdir(checkout, { recursive: true });
    await copyFile(path.join(root, ".env.example"), path.join(checkout, ".env.example"));
    await setupLocal(checkout);
    const loaded = nextEnv.loadEnvConfig(checkout, true, { info() {}, error: console.log }, true).parsedEnv?.VIDEO_FS_DATA_ROOT;
    const wanted = path.join(checkout, "data", "projects");
    console.log(`setupLocal in ".../${name}":`, loaded === wanted ? "data root reads back intact" : `MISMATCH wanted ${show(wanted)} got ${show(loaded)}`);
  }
});

await section("opening a web address without a shell", async () => {
  const url = "https://example.com/oauth/authorize?probe=first&second=two%20words";
  const [command, args] = process.platform === "win32"
    ? [path.join(process.env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", (error) => { console.log("opener error", error.code); resolve(); });
    child.on("close", (code) => { console.log("opener", show(command), "exit", code); resolve(); });
  });
});

await rm(tmp, { recursive: true, force: true }).catch(() => {});
