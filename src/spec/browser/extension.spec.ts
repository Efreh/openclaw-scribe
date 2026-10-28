import { chromium, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { createScribe } from "../../plugin/server.ts";
import { createDiarizationSession } from "../../plugin/diarization.ts";

test("packaged MV3 extension loads, renders safely and retains popup settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scribe-browser-"));
  const extension = resolve("../dist/browser");
  const context = await chromium.launchPersistentContext(dir, {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/popup.html`);
    await expect(page.locator("body")).toHaveJSProperty("inert", false);
    await expect(page.locator("#status")).toHaveText("Готово к записи");
    await expect(page.locator("#connection")).toHaveAttribute("open", "");
    await page.locator("#token").fill("test-settings-token");
    await page.locator("#diarization").check();
    await page.locator("#language").fill("en");
    await page.locator("#language").blur();
    await expect.poll(() => page.evaluate(() => chrome.storage.local.get("settings").then((data) => (data.settings as { language?: string })?.language))).toBe("en");
    await page.evaluate(async () => {
      await chrome.runtime.sendMessage({ target: "background", action: "state", state: {
        status: "recording", startedAt: Date.now(), tab: { id: 1, title: "Pinned meeting", url: "https://example.test/meeting" },
        levels: { tab: .1, mic: .02 }, lines: [{ speaker: "Вкладка", text: "<img src=x onerror=alert(1)>", offsetMs: 0 }],
      } });
    });
    await expect(page.locator("#status")).toHaveText("Идёт запись");
    await expect(page.locator("#tab")).toContainText("Pinned meeting");
    await expect(page.locator("#transcript")).toContainText("<img src=x onerror=alert(1)>");
    await expect(page.locator("#transcript img")).toHaveCount(0);
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto(`chrome-extension://${id}/popup.html`);
    await expect(reopened.locator("#status")).toHaveText("Идёт запись");
    await expect(reopened.locator("#language")).toHaveValue("en");
    await expect(reopened.locator("#token")).toHaveValue("test-settings-token");
    await expect(reopened.locator("#diarization")).toBeChecked();
    await expect(reopened.locator("#diarization")).toBeDisabled();
    await expect(reopened.locator("#start")).toBeDisabled();
    await expect(reopened.locator("#stop")).toBeEnabled();
    await reopened.locator("#show-text").uncheck();
    await expect(reopened.locator("#transcript")).toBeHidden();
  } finally { await context.close(); await rm(dir, { recursive: true, force: true }); }
});

test("real tab + microphone capture survives popup closure and tab switches, then flushes on stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scribe-capture-"));
  const captured: string[] = [];
  let finalized = false;
  const scribe = createScribe({ port: 0, token: "browser-integration-token", warn: () => {},
    createDiarization: (hello, sessionId) => createDiarizationSession({ workDir: join(dir, "staging"), sessionId, language: hello.language,
      diarize: async (_path, duration) => [{ start: 0, end: duration / 2, speaker: 1 }, { start: duration / 2, end: duration, speaker: 2 }],
    }), async transcribe(chunk) {
    captured.push(chunk.channel); return `Captured ${chunk.channel}`;
  } });
  await scribe.provider.watchOccupancy!({ source: { providerId: "openclaw-scribe" }, onEmpty() {}, onOccupied() {
    void scribe.provider.start!({ session: { sessionId: "browser-test", startedAt: new Date().toISOString(), source: { providerId: "openclaw-scribe" } },
      async onUtterance() {}, async onStatus(status) { if (!status.active) finalized = true; },
    });
  } });
  const port = await scribe.start();
  const web = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end('<!doctype html><title>Original audio tab</title><button id="play">Play test tone</button><script>play.onclick = async () => { const ctx = new AudioContext(); const tone = ctx.createOscillator(); const gain = ctx.createGain(); gain.gain.value = .1; tone.connect(gain).connect(ctx.destination); tone.start(); await ctx.resume(); };</script>');
  }).listen(0, "127.0.0.1");
  await once(web, "listening");
  const extension = resolve("../dist/browser");
  const context = await chromium.launchPersistentContext(dir, {
    // Headless playback must stay audible to the tab capturer; microphone input is synthetic.
    channel: "chromium", headless: true, ignoreDefaultArgs: ["--mute-audio"],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--enable-unsafe-extension-debugging", "--use-fake-device-for-media-stream"],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    await context.grantPermissions(["microphone"]);
    await worker.evaluate(async (port) => {
      await chrome.storage.local.set({ settings: { url: `ws://127.0.0.1:${port}`, token: "browser-integration-token", microphone: "default", language: "ru", showText: true, diarization: true } });
    }, port);
    const control = await context.newPage(); await control.goto(`chrome-extension://${id}/popup.html`);
    await expect(control.locator("body")).toHaveJSProperty("inert", false);
    const tab = await context.newPage(); await tab.goto(`http://127.0.0.1:${(web.address() as { port: number }).port}`);
    await tab.locator("#play").click();
    await tab.bringToFront();
    const browserCdp = await context.browser()!.newBrowserCDPSession();
    const { targetInfos } = await browserCdp.send("Target.getTargets", { filter: [{ type: "tab" }] });
    const target = targetInfos.find((target) => target.url === tab.url());
    expect(target).toBeDefined();
    await browserCdp.send("Extensions.triggerAction", { id, targetId: target!.targetId });
    const result = await control.evaluate(() => chrome.runtime.sendMessage({ target: "background", action: "start" }));
    expect(result.error).toBeUndefined();
    await expect(control.locator("#status")).toHaveText("Идёт запись");
    await control.close();
    const another = await context.newPage(); await another.goto("about:blank");
    await expect.poll(() => worker.evaluate(() => chrome.storage.session.get("state").then((data) => (data.state as { status: string })?.status))).toBe("recording");
    await expect.poll(() => captured, { timeout: 16_000 }).toEqual(expect.arrayContaining(["tab", "mic"]));
    const reopened = await context.newPage(); await reopened.goto(`chrome-extension://${id}/popup.html`);
    await expect(reopened.locator("#tab")).toContainText("Original audio tab");
    await expect(reopened.locator("#transcript")).toContainText("Captured tab");
    await reopened.screenshot({ path: "test-results/recording.png" });
    await reopened.locator("#stop").click();
    await expect(reopened.locator("#status")).toHaveText("Готово к записи");
    await expect(reopened.locator("#transcript")).toContainText("Участник 1");
    await expect(reopened.locator("#transcript")).toContainText("Участник 2");
    expect(finalized).toBe(true);
  } finally {
    await context.close(); await scribe.stop(); await new Promise<void>((r) => web.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
