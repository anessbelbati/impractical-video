// Probe: the steps of the project's "first-run setup can be skipped" test up to its return to the
// home page, then how many composer text boxes the page holds over the next seconds, and where
// each one sits when there are two. The project's test expects exactly one at that moment.
import { expect, test } from "@playwright/test";

test("composer text boxes on the home page after coming back from a new project", async ({ page, request }) => {
  await page.route("**/api/agent-connect?**", route => route.fulfill({ json: { agent: new URL(route.request().url()).searchParams.get("agent"), installed: true, signedIn: true, stage: "connected" } }));
  await page.goto("/?setup=1");
  await page.getByRole("button", { name: "Let’s get started" }).click();
  await expect(page.getByText("Installed and signed in", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Video models need a funded fal.ai key or Impractical credits.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.getByRole("button", { name: "Create my first project" }).click();
  await expect(page).toHaveURL(/\/projects\/[a-z0-9-]+$/);
  const projectId = new URL(page.url()).pathname.split("/").pop();
  await page.goto("/");

  const counts: number[] = [];
  let firstTwoAt = -1;
  let described = "";
  const started = Date.now();
  while (Date.now() - started < 2500) {
    let sample: { count: number; boxes: string[]; path: string } | null = null;
    try {
      sample = await page.evaluate(() => {
        const boxes = [...document.querySelectorAll("textarea.home-composer-textarea")];
        const label = (node: Element) => {
          const style = getComputedStyle(node);
          const marks = [node.hasAttribute("hidden") ? "[hidden]" : "", style.display === "none" ? "{display:none}" : "", style.visibility !== "visible" ? `{visibility:${style.visibility}}` : "", node.getAttribute("aria-hidden") ? "[aria-hidden]" : "", node.hasAttribute("inert") ? "[inert]" : ""].join("");
          const name = typeof node.className === "string" && node.className ? `.${node.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
          return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${name}${marks}`;
        };
        return {
          count: boxes.length,
          path: location.pathname + location.search,
          boxes: boxes.map((box) => {
            const chain: string[] = [];
            for (let node: Element | null = box; node && node !== document.documentElement; node = node.parentElement) chain.push(label(node));
            return `shown=${box.getClientRects().length > 0} chain=${chain.slice(0, 14).join(" < ")}`;
          }),
        };
      });
    } catch {
      // The page was between two documents.
    }
    if (sample) {
      counts.push(sample.count);
      if (sample.count >= 2 && firstTwoAt < 0) {
        firstTwoAt = Date.now() - started;
        described = `at ${sample.path}: ` + sample.boxes.map((box, index) => `(${index + 1}) ${box}`).join(" || ");
      }
    }
    await page.waitForTimeout(40);
  }
  const most = counts.length ? Math.max(...counts) : -1;
  console.log(`COMPOSERS most at once: ${most}; samples: ${counts.length}; samples with two or more: ${counts.filter((count) => count >= 2).length}; samples with none: ${counts.filter((count) => count === 0).length}; first two at ${firstTwoAt} ms; last sample: ${counts[counts.length - 1] ?? "none"}`);
  if (described) console.log(`COMPOSERS two boxes ${described}`);
  await request.delete(`/api/projects/${projectId}`);
});
