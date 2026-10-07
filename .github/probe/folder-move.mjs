// Probe, run by Node: what stops this system from moving a folder, the way the app moves a
// deleted project to its trash.
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const base = await mkdtemp(path.join(os.tmpdir(), "video-fs-folder-move-"));
let count = 0;

async function folder() {
  const directory = path.join(base, `project-${++count}`);
  await mkdir(path.join(directory, "media"), { recursive: true });
  await writeFile(path.join(directory, "project.json"), "{}\n");
  await writeFile(path.join(directory, "media", "clip.bin"), Buffer.alloc(1024));
  return directory;
}

async function move(directory) {
  const started = Date.now();
  try {
    await rename(directory, `${directory}-trashed`);
    return `moved in ${Date.now() - started} ms`;
  } catch (error) {
    return `REFUSED with ${error.code}`;
  }
}

async function attempt(title, hold) {
  const directory = await folder();
  const release = await hold(directory);
  const held = await move(directory);
  await release();
  let after = "(already moved)";
  // The system may need a moment to let go after the holder is gone.
  for (let waited = 0; held.startsWith("REFUSED") && waited <= 2000; waited += 50) {
    after = await move(directory);
    if (!after.startsWith("REFUSED")) {
      after += `, ${waited} ms after the holder let go`;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  console.log(`${title}\n    while held: ${held}\n    afterwards: ${after}`);
}

console.log(`${process.platform} ${os.release()}, Node ${process.version}`);
await attempt("nothing holds the folder", async () => async () => {});
await attempt("the folder is watched, as an open project page watches it", async (directory) => {
  const watcher = watch(directory, { recursive: true }, () => {});
  await new Promise((resolve) => setTimeout(resolve, 200));
  return async () => watcher.close();
});
await attempt("a file in the folder is open for reading", async (directory) => {
  const handle = await open(path.join(directory, "project.json"), "r");
  return () => handle.close();
});
await attempt("a file two folders down is open for reading", async (directory) => {
  const handle = await open(path.join(directory, "media", "clip.bin"), "r");
  return () => handle.close();
});
await attempt("another program's working folder is the folder, as an agent started in it has", async (directory) => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cwd: directory, stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  return async () => {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  };
});

// The app writes a small file into the folder and moves the folder at once. A virus scanner may
// still be reading that file: how often is the move refused then, and for how long?
const rounds = 300;
let refusedAtFirst = 0;
let neverMoved = 0;
let longest = 0;
for (let round = 0; round < rounds; round += 1) {
  const directory = await folder();
  await writeFile(path.join(directory, "deleted.json"), `${JSON.stringify({ deletedAt: new Date().toISOString() }, null, 2)}\n`);
  const started = Date.now();
  let tries = 0;
  for (;;) {
    try {
      await rename(directory, `${directory}-trashed`);
      break;
    } catch {
      tries += 1;
      if (Date.now() - started > 10_000) {
        neverMoved += 1;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  if (tries) {
    refusedAtFirst += 1;
    longest = Math.max(longest, Date.now() - started);
  }
}
console.log(`a file written into the folder just before the move, ${rounds} times\n    refused at first: ${refusedAtFirst} times, longest wait until it moved: ${longest} ms, never moved within 10 seconds: ${neverMoved}`);
await rm(base, { force: true, recursive: true }).catch(() => {});
