// Probe, run by Electron: what does the main process get on standard input, and by which route?
import { createReadStream, fstatSync, readFileSync } from "node:fs";
import net from "node:net";
import tty from "node:tty";
import { app } from "electron";
import { standardInput } from "../../desktop/standard-input.mjs";

const mode = process.env.PROBE_STDIN_MODE || "stream";

function descriptor() {
  try {
    const info = fstatSync(0);
    return { isCharacterDevice: info.isCharacterDevice(), isFIFO: info.isFIFO(), isFile: info.isFile(), isSocket: info.isSocket(), isTTY: tty.isatty(0) };
  } catch (error) {
    return { fstatError: String(error?.message ?? error) };
  }
}

let reported = false;
const report = (value) => {
  if (reported) return;
  reported = true;
  process.stdout.write(`${JSON.stringify({ mode, platform: process.platform, descriptor: descriptor(), ...value })}\n`);
  app.exit(0);
};

function readAll(stream) {
  let value = "";
  const kind = { constructor: stream?.constructor?.name, isProcessStdin: stream === process.stdin };
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    value += chunk;
  });
  stream.on("end", () => report({ kind, read: value }));
  stream.on("error", (error) => report({ kind, streamError: String(error?.message ?? error), code: error?.code, readSoFar: value }));
  setTimeout(() => report({ kind, timedOutAfterMs: 8000, readSoFar: value }), 8000);
}

try {
  if (mode === "sync") {
    report({ read: readFileSync(0, "utf8") });
  } else if (mode === "fd-stream") {
    readAll(createReadStream(null, { autoClose: false, fd: 0 }));
  } else if (mode === "socket") {
    readAll(new net.Socket({ fd: 0, readable: true, writable: false }));
  } else if (mode === "helper") {
    readAll(standardInput());
  } else if (mode === "helper-exit") {
    // The parent keeps the pipe open: does leaving still work while a read is waiting?
    const stream = standardInput();
    stream.on("data", () => {});
    stream.on("error", () => {});
    setTimeout(() => report({ leftWhileInputStillOpen: true }), 1000);
  } else {
    readAll(process.stdin);
  }
} catch (error) {
  report({ thrown: String(error?.message ?? error), code: error?.code });
}
