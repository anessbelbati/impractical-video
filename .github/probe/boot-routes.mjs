// Probe, run by Node from the repository root. Starts the smoke server the way Playwright does
// (same command, its own process group, SIGKILL at the end) several times in the same folder.
// After each start it asks whether the dev server knows the app's routes: a start counts as
// "missing-routes" when an address whose route file is on disk answers with Next's not-found
// page. It also reads the route list the dev server writes (.next/dev/types/routes.d.ts) and,
// in a start with missing routes, changes one file's time stamp under app/ to see whether the
// routes come back without a restart.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";

const origin = process.env.PROBE_ORIGIN || "http://localhost:3317";
const boots = Number(process.env.BOOTS || 20);
const idleMs = Number(process.env.IDLE_MS || 4000);
const settleMs = Number(process.env.SETTLE_MS || 3000);
const answerLimitMs = Number(process.env.ANSWER_LIMIT_MS || 180_000);
const logDir = "boot-logs";
const routeList = ".next/dev/types/routes.d.ts";
const touchFile = "app/api/library/tree/route.ts";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms) => (ms / 1000).toFixed(1);

function routeFiles(dir = "app", found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) routeFiles(full, found);
    else if (/^(route|page)\.(ts|tsx|js|jsx)$/.test(entry.name)) found.push(full);
  }
  return found;
}

// app/(shell)/explore/[id]/page.tsx is the route /explore/[id]: route groups are not in the address.
const routeOf = (file) => "/" + file.split("/").slice(1, -1).filter((part) => !/^\(.*\)$/.test(part)).join("/");

function readRouteList(routes, since) {
  if (!existsSync(routeList)) return { exists: false, fresh: false, lines: 0, missing: routes };
  const text = readFileSync(routeList, "utf8");
  return {
    exists: true,
    fresh: statSync(routeList).mtimeMs >= since - 1000,
    lines: text.split("\n").length,
    missing: routes.filter((route) => !text.includes(JSON.stringify(route))),
  };
}

function cacheSize() {
  if (!existsSync(".next/dev/cache")) return "none";
  if (process.platform === "win32") return "not measured";
  try {
    return execFileSync("du", ["-sh", ".next/dev/cache"], { encoding: "utf8" }).split("\t")[0].trim();
  } catch {
    return "not measured";
  }
}

function portAnswers() {
  const url = new URL(origin);
  return new Promise((resolve) => {
    const socket = net.connect(Number(url.port), url.hostname);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

async function ask(method, address) {
  try {
    const response = await fetch(origin + address, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
      ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Route probe" }) } : {}),
    });
    const type = response.headers.get("content-type") || "";
    let head = "";
    let json = null;
    if (response.body) {
      const reader = response.body.getReader();
      // Some of these addresses stream. One chunk is enough to tell a page from a handler's answer.
      const first = await Promise.race([reader.read(), sleep(3000).then(() => ({}))]);
      if (first.value) head = Buffer.from(first.value).toString("utf8");
      reader.cancel().catch(() => {});
      try { json = JSON.parse(head); } catch { /* not JSON, or more than one chunk */ }
    }
    const notFoundPage = response.status === 404 && /text\/html/i.test(type);
    return { address, status: response.status, type: type.split(";")[0], notFoundPage, json, error: null };
  } catch (error) {
    return { address, status: 0, type: "", notFoundPage: false, json: null, error: String(error?.cause?.code || error?.name || error) };
  }
}

async function waitForAnswer(startedAt) {
  let last = null;
  while (Date.now() - startedAt < answerLimitMs) {
    try {
      const response = await fetch(origin + "/", { redirect: "manual", signal: AbortSignal.timeout(120_000) });
      await response.body?.cancel();
      last = response.status;
      // The range Playwright accepts before it starts the tests.
      if (response.status >= 200 && response.status < 404) return { status: response.status, ms: Date.now() - startedAt, inRange: true };
    } catch { /* not listening yet */ }
    await sleep(100);
  }
  return { status: last, ms: Date.now() - startedAt, inRange: false };
}

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL");
  } catch { /* already gone */ }
}

async function boot(number, routes) {
  const logFile = `${logDir}/boot-${number}.log`;
  const fd = openSync(logFile, "w");
  const cacheBefore = cacheSize();
  const startedAt = Date.now();
  const child = spawn(process.execPath, ["scripts/smoke-server.mjs"], { detached: process.platform !== "win32", stdio: ["ignore", fd, fd] });
  const result = { number, verdict: "did-not-answer", answerMs: null, repaired: null };
  try {
    const answer = await waitForAnswer(startedAt);
    result.answerMs = answer.ms;
    console.log(`BOOT ${number}: dev cache before the start: ${cacheBefore}; first page answered ${answer.status ?? "nothing"} after ${seconds(answer.ms)} s`);
    if (answer.status === null) return result;

    const created = await ask("POST", "/api/projects");
    const id = created.json?.project?.id ?? null;
    console.log(`BOOT ${number}: a new project: status ${created.status}${id ? "" : ", no id in the answer, a made-up id is used below"}`);
    const p = `/api/projects/${id ?? "route-probe"}`;
    // [address, how many folders below the first dynamic folder its route file sits]
    const dynamic = [
      [p, 0],
      [`${p}/tracks`, 1],
      [`${p}/prompts`, 1],
      [`${p}/chat/stream`, 2],
      [`${p}/canvas/upload`, 2],
      [`${p}/canvas/lineage`, 2],
      [`${p}/agent-context/status`, 2],
      [`${p}/media/uploads/none.png`, 2],
      [`${p}/chat/stream/none`, 3],
      [`${p}/canvas/import-youtube/none/requirements`, 4],
      ["/api/published-items/none/use", 1],
      ["/api/library/items/none/placement", 1],
    ];
    const fixed = ["/api/library/tree", "/api/projects/active-runs"];
    const answers = [];
    for (const [address] of dynamic) answers.push(await ask("GET", address));
    const controls = [];
    for (const address of fixed) controls.push(await ask("GET", address));

    const depth = new Map(dynamic);
    const lost = answers.filter((entry) => entry.notFoundPage);
    const failed = answers.filter((entry) => entry.error);
    const short = (address) => address.replace(p, "/api/projects/<id>");
    console.log(`BOOT ${number}: addresses below a dynamic folder: ${answers.length - lost.length - failed.length} answered by their handler, ${lost.length} got the not-found page, ${failed.length} gave no answer`);
    console.log(`BOOT ${number}: each one: ${answers.map((entry) => `${short(entry.address)}=${entry.error ?? entry.status}${entry.notFoundPage ? "(page)" : ""}`).join(" ")}`);
    console.log(`BOOT ${number}: addresses without a dynamic folder: ${controls.map((entry) => `${entry.address}=${entry.error ?? entry.status}${entry.notFoundPage ? "(page)" : ""}`).join(" ")}`);
    if (lost.length) console.log(`BOOT ${number}: the not-found ones, with their depth below the dynamic folder: ${lost.map((entry) => `${short(entry.address)} [${depth.get(entry.address)}]`).join(", ")}`);

    const list = readRouteList(routes, startedAt);
    console.log(`BOOT ${number}: ${routeList}: ${list.exists ? `${list.lines} lines, written in this start: ${list.fresh ? "yes" : "no"}, lists ${routes.length - list.missing.length} of the ${routes.length} routes on disk` : "not there"}`);
    if (list.exists && list.missing.length) console.log(`BOOT ${number}: routes on disk that the list leaves out (${list.missing.length}): ${list.missing.slice(0, 14).join(", ")}${list.missing.length > 14 ? ", ..." : ""}`);
    result.listMissing = list.exists ? list.missing.length : null;

    if (lost.length || controls.some((entry) => entry.notFoundPage)) {
      result.verdict = "missing-routes";
      result.lost = lost.length;
      const now = new Date();
      utimesSync(touchFile, now, now);
      await sleep(settleMs);
      let still = [];
      for (const entry of lost) if ((await ask("GET", entry.address)).notFoundPage) still.push(entry.address);
      let how = "its time stamp changed";
      if (still.length) {
        const original = readFileSync(touchFile);
        writeFileSync(touchFile, Buffer.concat([original, Buffer.from("\n")]));
        await sleep(700);
        writeFileSync(touchFile, original);
        await sleep(settleMs);
        const again = [];
        for (const address of still) if ((await ask("GET", address)).notFoundPage) again.push(address);
        still = again;
        how = "a blank line added and taken out again";
      }
      const after = readRouteList(routes, startedAt);
      result.repaired = still.length === 0;
      console.log(`BOOT ${number}: after ${touchFile} had ${how}, with no restart: ${lost.length - still.length} of the ${lost.length} answer from their handler; the list now has ${routes.length - after.missing.length} of ${routes.length}`);
    } else if (failed.length) {
      result.verdict = "no-answer-from-some";
    } else {
      result.verdict = "healthy";
    }
    await sleep(idleMs);
    return result;
  } finally {
    stop(child);
    for (let waited = 0; waited < 15_000 && (await portAnswers()); waited += 250) await sleep(250);
    closeSync(fd);
    const log = readFileSync(logFile, "utf8");
    const ready = log.match(/Ready in [0-9.]+\s?m?s/);
    result.actionErrors = (log.match(/Failed to find Server Action/g) || []).length;
    console.log(`BOOT ${number}: VERDICT ${result.verdict}; the server said "${ready ? ready[0] : "no Ready line"}"; lines saying 'Failed to find Server Action': ${result.actionErrors}; dev cache after: ${cacheSize()}`);
  }
}

const routes = routeFiles().map(routeOf).sort();
const next = JSON.parse(readFileSync("node_modules/next/package.json", "utf8")).version;
const cacheOff = /VIDEO_FS_DEV_CACHE/.test(readFileSync("scripts/smoke-server.mjs", "utf8"));
mkdirSync(logDir, { recursive: true });
console.log(`next ${next}; node ${process.version}; ${process.platform}; route files under app/: ${routes.length}; the smoke server turns the dev cache off: ${cacheOff ? "yes" : "no"}; starts planned: ${boots}`);
if (await portAnswers()) {
  console.log("something already answers on the port: stopping");
  process.exit(1);
}

const results = [];
for (let number = 1; number <= boots; number += 1) results.push(await boot(number, routes));

const count = (verdict) => results.filter((entry) => entry.verdict === verdict).length;
const lostBoots = results.filter((entry) => entry.verdict === "missing-routes");
const spread = (list) => {
  const sorted = list.map((entry) => entry.answerMs).filter((ms) => ms !== null).sort((a, b) => a - b);
  return sorted.length ? `${seconds(sorted[0])} / ${seconds(sorted[Math.floor(sorted.length / 2)])} / ${seconds(sorted[sorted.length - 1])}` : "none";
};
console.log(`RESULT starts: ${results.length}; healthy: ${count("healthy")}; missing-routes: ${lostBoots.length}; no answer from some addresses: ${count("no-answer-from-some")}; did not answer at all: ${count("did-not-answer")}`);
console.log(`RESULT starts with missing routes, by number: ${lostBoots.map((entry) => entry.number).join(", ") || "none"}`);
console.log(`RESULT of those, routes back after a file under app/ changed, with no restart: ${lostBoots.filter((entry) => entry.repaired).length} of ${lostBoots.length}`);
console.log(`RESULT of those, the route list left routes out: ${lostBoots.filter((entry) => entry.listMissing > 0).length} of ${lostBoots.length}; healthy starts whose list left routes out: ${results.filter((entry) => entry.verdict === "healthy" && entry.listMissing > 0).length}`);
console.log(`RESULT seconds until the first page answered, shortest / middle / longest: healthy ${spread(results.filter((entry) => entry.verdict === "healthy"))}; missing-routes ${spread(lostBoots)}`);
console.log(`RESULT lines saying 'Failed to find Server Action' over all starts: ${results.reduce((sum, entry) => sum + (entry.actionErrors || 0), 0)}`);
process.exit(0);
