import { chromium, expect, test } from "@playwright/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { createScribe } from "../../plugin/server.ts";
import { createRecordingSession } from "../../plugin/recording.ts";
import { openActionPopup } from "../support/action-popup.ts";

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
    await page.locator("#save-audio").check();
    await page.getByRole("button", { name: "Включить светлую тему" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
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
    await expect(reopened.locator("#save-audio")).toBeChecked();
    await expect(reopened.locator("#save-audio")).toBeDisabled();
    await expect(reopened.locator("html")).toHaveAttribute("data-theme", "light");
    await reopened.getByRole("button", { name: "Включить тёмную тему" }).click();
    await expect(reopened.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(reopened.locator("#start")).toBeDisabled();
    await expect(reopened.locator("#stop")).toBeEnabled();
    await reopened.locator("#show-text").uncheck();
    await expect(reopened.locator("#transcript")).toBeHidden();
  } finally { await context.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const [diarization, saveAudio, showText] of [[true, false, true], [true, true, false], [false, true, false]] as const) test(`real capture survives popup closure; diarization=${diarization}, saveAudio=${saveAudio}, demo=${showText}`, async () => {
  test.setTimeout(60_000);
  const dir = await mkdtemp(join(tmpdir(), "scribe-capture-"));
  const captured: string[] = [];
  let finalized = false;
  let stopped = false;
  let recordingPath = "";
  const opened: string[] = [];
  const finalSources: string[] = [];
  const scribe = createScribe({ port: 0, token: "browser-integration-token", warn: () => {},
    async createRecording(hello, sessionId) {
      const session = await createRecordingSession({ workDir: join(dir, "staging"), sessionId, language: hello.language, saveAudio: hello.saveAudio, recordingsDir: join(dir, "saved"),
        diarize: hello.diarization ? async (_path, duration) => [{ start: 0, end: duration / 2, speaker: 1 }, { start: duration / 2, end: duration, speaker: 2 }] : undefined,
      });
      recordingPath = session.path; return session;
    }, async transcribe(chunk) {
    (stopped ? finalSources : captured).push(chunk.channel); return `Captured ${chunk.channel}`;
  }, openRecording: async (id, recovery) => { expect(recovery).toBe(false); opened.push(id); } });
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
    await worker.evaluate(async ({ port, showText, diarization, saveAudio }) => {
      await chrome.storage.local.set({ settings: { url: `ws://127.0.0.1:${port}`, token: "browser-integration-token", microphone: "default", language: "ru", showText, diarization, saveAudio } });
    }, { port, showText, diarization, saveAudio });
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
    if (showText) await expect.poll(() => captured, { timeout: 16_000 }).toEqual(expect.arrayContaining(["tab", "mic"]));
    else {
      await expect.poll(() => stat(join(recordingPath, "mic.wav")).then((s) => s.size, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      }), { timeout: 16_000 }).toBeGreaterThan(320_000);
      expect(captured).toEqual([]);
    }
    const reopened = await context.newPage(); await reopened.goto(`chrome-extension://${id}/popup.html`);
    await expect(reopened.locator("#tab")).toContainText("Original audio tab");
    if (!showText) {
      await expect(reopened.locator("#transcript")).toBeHidden();
      await reopened.locator("#show-text").check();
      await expect.poll(() => captured, { timeout: 16_000 }).toEqual(expect.arrayContaining(["tab", "mic"]));
    }
    await expect(reopened.locator("#transcript")).toContainText("Captured tab");
    if (!showText) {
      await reopened.locator("#show-text").uncheck();
      const count = captured.length;
      const bytes = (await stat(join(recordingPath, "mic.wav"))).size;
      await expect.poll(async () => (await stat(join(recordingPath, "mic.wav"))).size, { timeout: 16_000 }).toBeGreaterThan(bytes);
      expect(captured).toHaveLength(count);
      // Show final transcript after stop without starting another live chunk.
      await reopened.locator("#show-text").check();
    }
    await reopened.screenshot({ path: "test-results/recording.png" });
    stopped = true;
    await reopened.locator("#stop").click();
    await expect(reopened.locator("#status")).toHaveText("Запись готова");
    if (diarization) {
      await expect(reopened.locator("#transcript")).toContainText("Участник 1");
      await expect(reopened.locator("#transcript")).toContainText("Участник 2");
    } else await expect(reopened.locator("#transcript")).toContainText("Вкладка");
    if (saveAudio) {
      await expect(reopened.locator("#audio-files")).toContainText("tab.wav");
      await expect(reopened.locator("#audio-files")).toContainText("mic.wav");
      await reopened.locator("#open-folder").click();
      await expect.poll(() => opened.length).toBe(1);
      await expect.poll(() => stat(join(dir, "saved", opened[0]!, "tab.wav")).then((s) => s.size)).toBeGreaterThan(44);
    } else await expect(reopened.locator("#open-folder")).toBeHidden();
    await reopened.locator("#new").click();
    await expect(reopened.locator("#status")).toHaveText("Готово к записи");
    await expect(reopened.locator("#save-audio")).toBeEnabled();
    expect(finalized).toBe(true);
    expect(finalSources).toEqual(expect.arrayContaining(["tab", "mic"]));
  } finally {
    await context.close(); await scribe.stop(); await new Promise<void>((r) => web.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});


test("real browser-action popup keeps 400px content and visible controls in both themes and all states", async ({}, testInfo) => {
  const dir = await mkdtemp(join(tmpdir(), "scribe-action-layout-"));
  const extension = resolve("../dist/browser");
  const context = await chromium.launchPersistentContext(dir, {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--enable-unsafe-extension-debugging"],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    const host = await context.newPage();
    await host.goto("data:text/html,<title>Popup layout regression</title>");
    for (const theme of ["dark", "light"]) for (const status of ["idle", "recording", "done"]) {
      await worker.evaluate(async ({ theme, status }) => {
        await chrome.storage.local.set({ settings: { token: "popup-layout-only", microphone: "default", language: "ru",
          showText: true, diarization: true, saveAudio: true, theme } });
        await chrome.storage.session.set({ state: { status, diarization: true, saveAudio: true, fullRecording: true,
          microphone: "default", tab: { id: 1, title: "Длинное название командной встречи для проверки размеров", url: "https://example.test" },
          levels: { tab: .1, mic: .05 }, lines: status === "idle" ? [] : [{ speaker: "Вкладка", text: "Проверка отображения текста.", offsetMs: 0 }],
          ...(status !== "idle" ? { startedAt: Date.now() - 270000 } : {}),
          ...(status === "done" ? { endedAt: Date.now(), audio: { id: "recording-TEST12", directory: "/recordings/recording-TEST12", files: ["tab", "mic"], recovery: false } } : {}),
        } });
      }, { theme, status });
      await host.bringToFront();
      const popup = await openActionPopup(context, id, host);
      try {
        await expect.poll(() => popup.evaluate("document.body?.inert === false")).toBe(true);
        await expect.poll(() => popup.evaluate("document.body.getBoundingClientRect().width")).toBe(400);
        await expect.poll(() => popup.evaluate("innerHeight >= 200 && document.querySelector('.actions').getBoundingClientRect().bottom <= innerHeight")).toBe(true);
        const layout = await popup.evaluate<{ width: number; height: number; root: number; body: number; scroll: number; footer: number; isPopup: boolean; theme: string; state: string; labelLines: number }>(`(() => {
          const range = document.createRange();
          range.selectNodeContents(document.querySelector('label[for="diarization"] span').firstChild);
          return { width: innerWidth, height: innerHeight, root: document.documentElement.getBoundingClientRect().width,
            body: document.body.getBoundingClientRect().width, scroll: document.documentElement.scrollWidth,
            footer: document.querySelector('.actions').getBoundingClientRect().bottom,
            isPopup: chrome.extension.getViews({ type: 'popup' }).includes(window),
            theme: document.documentElement.dataset.theme, state: document.body.dataset.status,
            labelLines: range.getClientRects().length };
        })()`);
        expect(layout.isPopup).toBe(true);
        expect(layout.root).toBe(400); expect(layout.body).toBe(400);
        // Chromium may reserve a native scrollbar gutter when clamping popup height.
        expect(layout.width).toBeGreaterThanOrEqual(400); expect(layout.width).toBeLessThanOrEqual(432);
        expect(layout.scroll).toBeLessThanOrEqual(layout.width);
        expect(layout.height).toBeLessThanOrEqual(600); expect(layout.footer).toBeLessThanOrEqual(layout.height);
        expect(layout.theme).toBe(theme); expect(layout.state).toBe(status);
        if (status === "idle") expect(layout.labelLines).toBe(1);
        await testInfo.attach("action-popup-" + theme + "-" + status, { body: await popup.screenshot(), contentType: "image/png" });
      } finally { await popup.close(); }
    }
  } finally { await context.close(); await rm(dir, { recursive: true, force: true }); }
});
