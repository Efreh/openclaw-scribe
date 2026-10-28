import { idle, settings } from "./state.ts";
import type { State, Tab } from "./state.ts";

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
