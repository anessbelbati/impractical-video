// Probe: what a server that has just started answers to the first canvas upload, the request the
// project's own "fresh local install" test begins with.
import { expect, test, type APIResponse } from "@playwright/test";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4WQAAAAASUVORK5CYII=", "base64");

async function show(what: string, response: APIResponse) {
  const text = (await response.text()).replace(/\s+/g, " ");
  console.log(`${what}: status ${response.status()}, type ${response.headers()["content-type"] ?? "(none)"}, ${text.length} characters`);
  if (response.status() >= 400) {
    console.log(`  headers: ${JSON.stringify(response.headers())}`);
    // An error page is long: the title and the first error text say which page answered.
    console.log(`  title: ${/<title>(.*?)<\/title>/.exec(text)?.[1] ?? "(no title)"}`);
    console.log(`  start: ${text.slice(0, 400)}`);
    for (const match of text.matchAll(/(Failed to find Server Action|could not be found|404|digest)[^<]{0,160}/g)) {
      console.log(`  mentions: ${match[0].slice(0, 200)}`);
      break;
    }
  }
}

test("the first canvas upload a fresh server receives", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByPlaceholder("What do you want to make?")).toBeVisible();
  const created = await request.post("/api/projects", { data: { name: "Upload probe" } });
  console.log("create project: status", created.status());
  const { project } = await created.json();
  console.log("project id:", project.id);
  const upload = () => request.post(`/api/projects/${project.id}/canvas/upload`, { multipart: { files: { name: "pixel.png", mimeType: "image/png", buffer: png } } });
  try {
    for (const round of [1, 2, 3]) await show(`upload ${round}`, await upload());
    await show("the same address asked for as JSON, not as a form", await request.post(`/api/projects/${project.id}/canvas/upload`, { data: { not: "a form" } }));
    await show("another address in the same folder (canvas/state)", await request.get(`/api/projects/${project.id}/canvas/state`));
    await show("the project itself", await request.get(`/api/projects/${project.id}`));
    await page.goto(`/projects/${project.id}`);
    await expect(page.getByRole("tab", { name: "Editor", exact: true })).toBeVisible();
    await show("upload after the project page was opened", await upload());
    await page.goto("/library");
    await show("upload after the library page was opened", await upload());
  } finally {
    console.log("delete project: status", (await request.delete(`/api/projects/${project.id}`)).status());
  }
});
