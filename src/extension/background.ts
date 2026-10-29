import { idle, settings } from "./state.ts";
import type { Settings, State, Tab } from "./state.ts";

// Offscreen documents only support chrome.runtime, not chrome.storage.
chrome.storage.onChanged.addListener((changes, area) => {
  const updated = changes.settings?.newValue as Partial<Settings> | undefined;
  if (area !== "local" || typeof updated?.showText !== "boolean" || (changes.settings?.oldValue as Partial<Settings> | undefined)?.showText === updated.showText) return;
  void chrome.runtime.sendMessage({ target: "offscreen", action: "preview", enabled: updated.showText }).catch(() => {});
});

let busy = false;
chrome.runtime.onMessage.addListener((request, _sender, respond) => {
  if (request.target !== "background") return;
  void handle(request).then(respond, (error) => respond({ error: String(error instanceof Error ? error.message : error) }));
  return true;
});

async function handle(request: { action: string; state?: State }) {
  if (request.action === "get") return (await chrome.storage.session.get("state")).state ?? idle();
  if (request.action === "state" && request.state) {
    const state = request.state;
    await chrome.storage.session.set({ state });
    await chrome.action.setBadgeText({ text: state.status === "recording" ? "REC" : state.status === "stopping" ? "…" : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#d94747" });
    void chrome.runtime.sendMessage({ target: "popup", state }).catch(() => {});
    return { ok: true };
  }
  if (request.action === "reset") {
    const previous = (await chrome.storage.session.get<{ state?: State }>("state")).state;
    if (previous && ["starting", "recording", "stopping"].includes(previous.status)) throw new Error("Сначала завершите запись");
    await chrome.storage.session.set({ state: idle() });
    return idle();
  }
  if (request.action === "open-recording") {
    const state = (await chrome.storage.session.get<{ state?: State }>("state")).state;
    if (!state?.audio?.files.length) throw new Error("Нет сохранённых аудиофайлов");
    const config = await settings();
    const { validateEndpoint } = await import("../shared/protocol.ts");
    await new Promise<void>((resolve, reject) => {
      const connection = new WebSocket(validateEndpoint(config.url));
      const timer = setTimeout(() => done(new Error("Не удалось открыть папку: OpenClaw не ответил")), 12_000);
      let settled = false;
      function done(error?: Error) {
        if (settled) return;
        settled = true; clearTimeout(timer); connection.close();
        error ? reject(error) : resolve();
      }
      connection.onopen = () => connection.send(JSON.stringify({ type: "open-recording", token: config.token,
        recordingId: state.audio!.id, recovery: state.audio!.recovery }));
      connection.onmessage = ({ data }) => {
        const value = JSON.parse(String(data)) as { type: string; message?: string };
        if (value.type === "folder-opened") done();
        else if (value.type === "error") done(new Error(value.message ?? "Не удалось открыть папку"));
      };
      connection.onerror = () => done(new Error("Нет соединения с OpenClaw"));
      connection.onclose = () => { if (!settled) done(new Error("Соединение закрыто до открытия папки")); };
    });
    return { ok: true };
  }
  if (request.action === "stop") return chrome.runtime.sendMessage({ target: "offscreen", action: "stop" });
  if (request.action !== "start") throw new Error("Unknown recorder action");
  const previous = (await chrome.storage.session.get<{ state?: State }>("state")).state ?? idle();
  if (busy || ["starting", "recording", "stopping"].includes(previous.status)) throw new Error("Запись уже запущена");
  busy = true;
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active?.id || !/^https?:/.test(active.url ?? "")) throw new Error("Откройте обычную веб-вкладку перед записью");
    const tab: Tab = { id: active.id, title: active.title || "Вкладка", url: active.url! };
    // Capture the selected ID once. Switching browser tabs cannot retarget this stream.
    if (!(await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length) {
      await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: [chrome.offscreen.Reason.USER_MEDIA], justification: "Record the selected tab and microphone independently of the popup lifetime" });
    }
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const result = await chrome.runtime.sendMessage({ target: "offscreen", action: "start", streamId, tab, settings: await settings() });
    if (result?.error) throw new Error(result.error);
    return { ok: true };
  } finally { busy = false; }
}
