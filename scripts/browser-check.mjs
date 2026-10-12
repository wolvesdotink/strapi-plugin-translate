import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = process.env.TRANSLATE_FIXTURE_URL || "http://localhost:1348";
const output =
  process.env.TRANSLATE_SCREENSHOT_DIR || path.join(root, "docs/screenshots");
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
});
const page = await context.newPage();
const capture = (target, filename) =>
  target.screenshot({
    path: path.join(output, filename),
    animations: "disabled",
    caret: "hide",
  });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(`${base}/admin`);
  await page.getByLabel("Email").fill("translate-fixture@example.test");
  await page.locator('input[name="password"]').fill("FixtureOnly123!");
  const loginPromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/admin/login") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Login", exact: true }).click();
  const login = await loginPromise;
  assert.equal(login.status(), 200);
  const token = (await login.json()).data.token;
  await page.waitForURL("**/admin");
  const headers = { Authorization: `Bearer ${token}` };
  const list = await page.request.get(
    `${base}/content-manager/collection-types/api::page.page?locale=de`,
    { headers },
  );
  const sourceEntry = (await list.json()).results[0];
  const documentId = sourceEntry.documentId;
  assert.equal(
    sourceEntry.modules[1].title,
    "Unsere Reisetipps",
    "Use a fresh fixture directory for this check.",
  );
  await page.goto(
    `${base}/admin/content-manager/collection-types/api::page.page/${documentId}?plugins[i18n][locale]=de`,
  );
  await page.getByRole("button", { name: "Save", exact: true }).waitFor();
  await page.getByRole("button", { name: /Featured articles -/ }).click();
  const title = page.locator('input[name="modules.1.title"]');
  await title.waitFor();
  await page
    .getByText(
      "No pending changes. Save an edit to translate just the modules you changed.",
      {
        exact: true,
      },
    )
    .waitFor();
  await capture(page, "before-editor.png");
  await title.fill("Entdecke unsere neuesten Reisetipps");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("dialog").waitFor({ timeout: 20000 });
  assert.match(
    await page.getByRole("dialog").innerText(),
    /Translate saved changes/,
  );
  await page.getByRole("checkbox", { name: /^English/ }).check();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === "Preview translations",
    );
    return (
      button &&
      !button.disabled &&
      button.getAttribute("aria-disabled") !== "true"
    );
  });
  await page.getByText(/^Estimated usage/).waitFor();
  await capture(page, "after-save-prompt.png");
  const mobile = await page.context().newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(
    `${base}/admin/content-manager/collection-types/api::page.page/${documentId}?plugins[i18n][locale]=de`,
  );
  await mobile
    .getByRole("button", { name: "Open more actions", exact: true })
    .click();
  await mobile
    .getByRole("button", { name: "Translate changes", exact: true })
    .click();
  await mobile.getByRole("checkbox", { name: /^English/ }).check();
  const promptBounds = await mobile.getByRole("dialog").boundingBox();
  assert.ok(promptBounds.x >= 0 && promptBounds.x + promptBounds.width <= 390);
  assert.equal(
    await mobile
      .getByRole("dialog")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
    true,
  );
  await mobile.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === "Preview translations",
    );
    return (
      button &&
      !button.disabled &&
      button.getAttribute("aria-disabled") !== "true"
    );
  });
  await mobile.getByText(/^Estimated usage/).waitFor();
  await capture(mobile, "after-save-prompt-mobile.png");
  await mobile
    .getByRole("button", { name: "Preview translations", exact: true })
    .click();
  await mobile
    .getByText("Discover our latest travel tips", { exact: true })
    .waitFor({ timeout: 20000 });
  assert.equal(
    await mobile
      .getByRole("dialog")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
    true,
  );
  await capture(mobile, "after-module-preview-mobile.png");
  await mobile
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await mobile.close();
  await page
    .getByRole("button", { name: "Preview translations", exact: true })
    .click();
  await page
    .getByText("Discover our latest travel tips", { exact: true })
    .waitFor({ timeout: 20000 });
  await capture(page, "after-module-preview.png");
  await page.getByRole("button", { name: /^Apply to English/ }).click();
  await page.getByText(/^English.* updated$/).waitFor({ timeout: 15000 });
  const targetResponse = await page.request.get(
    `${base}/content-manager/collection-types/api::page.page/${documentId}?locale=en`,
    { headers },
  );
  const target = (await targetResponse.json()).data;
  assert.equal(target.modules[1].title, "Discover our latest travel tips");
  assert.equal(
    target.modules[1].description,
    "An independently edited article intro.",
  );
  assert.equal(
    target.modules[0].description,
    "An editor wrote this description.",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await page.goto(
    `${base}/admin/content-manager/collection-types/api::page.page/${documentId}?plugins[i18n][locale]=en`,
  );
  await page.getByRole("button", { name: /Featured articles -/ }).click();
  await page.locator('input[name="modules.1.title"]').waitFor();
  await capture(page, "after-english-content.png");
  await page.goto(
    `${base}/admin/content-manager/collection-types/api::page.page/${documentId}?plugins[i18n][locale]=de`,
  );
  await page.getByRole("button", { name: "Save", exact: true }).waitFor();
  await page.getByRole("button", { name: /Featured articles -/ }).click();
  await page
    .locator('input[name="modules.1.title"]')
    .fill("Aktuelle Reiseinspiration");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("checkbox", { name: /^English/ }).check();
  await page.getByRole("checkbox", { name: "French", exact: true }).check();
  await page
    .getByRole("button", { name: "Preview translations", exact: true })
    .click();
  await page
    .getByText("[en] Aktuelle Reiseinspiration", { exact: true })
    .waitFor({ timeout: 20000 });
  await page.getByRole("tab", { name: /^French/ }).click();
  await page
    .getByText("[fr] Aktuelle Reiseinspiration", { exact: true })
    .waitFor();
  await capture(page, "after-missing-link.png");
  assert.equal(
    await page.getByRole("button", { name: /^Apply to French/ }).isDisabled(),
    true,
  );
  await page
    .getByRole("checkbox", {
      name: "Apply without these links",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: /^Apply to French/ }).click();
  await page.getByText(/^French.* updated$/).waitFor();
  await page.getByRole("tab", { name: /^English/ }).click();
  await page.getByRole("button", { name: /^Apply to English/ }).click();
  await page.getByText(/^English.* updated$/).waitFor();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Done", exact: true })
    .click();

  // A linked child needs a separate approval to omit its own missing links.
  const createArticle = async (data) => {
    const response = await page.request.post(
      `${base}/content-manager/collection-types/api::article.article`,
      {
        headers,
        data: { locale: "de", ...data },
      },
    );
    assert.ok(response.ok(), await response.text());
    return (await response.json()).data;
  };
  const articleB = await createArticle({
    title: "Review article B",
    body: "Second article",
  });
  const articleA = await createArticle({
    title: "Review article A",
    body: "First article",
    related: { set: [{ documentId: articleB.documentId }] },
  });
  const current = await page.request.get(
    `${base}/content-manager/collection-types/api::page.page/${documentId}?locale=de`,
    { headers },
  );
  const currentSource = (await current.json()).data;
  const save = await page.request.put(
    `${base}/content-manager/collection-types/api::page.page/${documentId}`,
    {
      headers,
      data: {
        locale: "de",
        modules: currentSource.modules.map((module) => ({
          id: module.id,
          __component: module.__component,
          title: module.title,
          description: module.description,
          ...(module.articles
            ? { articles: { set: [{ documentId: articleA.documentId }] } }
            : {}),
        })),
      },
    },
  );
  assert.ok(save.ok(), await save.text());
  await page.goto(
    `${base}/admin/content-manager/collection-types/api::page.page/${documentId}?plugins[i18n][locale]=de`,
  );
  await page
    .getByRole("button", { name: "Translate changes", exact: true })
    .click();
  await page.getByRole("checkbox", { name: /^English/ }).uncheck();
  await page.getByRole("checkbox", { name: "French", exact: true }).check();
  await page
    .getByRole("checkbox", {
      name: "Also translate linked items",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Preview translations", exact: true })
    .click();
  const childOmission = page.getByRole("checkbox", {
    name: "Apply Review article A without these links",
    exact: true,
  });
  await childOmission.waitFor({ timeout: 20000 });
  const applyChild = page.getByRole("button", { name: /^Apply to French/ });
  assert.equal(await applyChild.isDisabled(), true);
  await childOmission.check();
  await childOmission.scrollIntoViewIfNeeded();
  await capture(page, "after-linked-item-preview.png");
  const acceptance = page.waitForRequest(
    (request) =>
      request.url().includes("/accept") && request.method() === "POST",
  );
  await applyChild.click();
  const acceptedBody = (await acceptance).postDataJSON();
  assert.deepEqual(Object.values(acceptedBody.childAllowMissingRelations), [
    true,
  ]);
  assert.equal(acceptedBody.allowMissingRelations, false);
  await page.getByText(/^French.* updated$/).waitFor();
  const childResponse = await page.request.get(
    `${base}/content-manager/collection-types/api::article.article/${articleA.documentId}?locale=fr`,
    { headers },
  );
  const savedChild = (await childResponse.json()).data;
  assert.equal(savedChild.locale, "fr");
  assert.equal(savedChild.related.count, 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS real admin saves, desktop/mobile previews, two-language acceptance, parent/child optional-link approvals, and preserved manual copy.",
  );
} catch (error) {
  await page
    .screenshot({ path: "/tmp/translate-browser-failure.png" })
    .catch(() => {});
  console.log(
    "FAILED UI",
    (await page.locator("body").innerText()).slice(-6500),
  );
  console.log("Browser errors", errors);
  throw error;
} finally {
  await browser.close();
}
