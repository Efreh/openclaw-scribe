import { settings } from "./state.ts";
import type { Settings, State } from "./state.ts";
import { validateEndpoint } from "../shared/protocol.ts";

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
let config: Settings = await settings();
let current: State;
for (const key of ["url", "token", "language"] as const) input(key).value = config[key];
input("show-text").checked = config.showText;
input("diarization").checked = config.diarization;
el("diarization-hint").hidden = !config.diarization;
el<HTMLDetailsElement>("connection").open = !config.token;
const microphone = el<HTMLSelectElement>("microphone");
try {
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const device of devices.filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default")) {
    microphone.add(new Option(device.label || "Микрофон", device.deviceId));
  }
} catch { /* Default microphone remains available before permission. */ }
microphone.value = config.microphone;
if (!microphone.value) { microphone.add(new Option("Выбранный микрофон недоступен", config.microphone)); microphone.value = config.microphone; }

async function save() {
  config = {
    url: validateEndpoint(input("url").value.trim()), token: input("token").value.trim(),
    language: input("language").value.trim(), microphone: microphone.value, showText: input("show-text").checked,
    diarization: input("diarization").checked,
  };
  if (!/^[a-z]{2,3}$/.test(config.language)) throw new Error("Код языка: ru, en и т. п.");
  await chrome.storage.local.set({ settings: config });
}
function error(value: string) { el("error").textContent = value; el("error").hidden = !value; }
function render(state: State) {
  current = state;
  const labels = { idle: "Готово к записи", starting: "Подключение…", recording: "Идёт запись", stopping: "Распознавание и сохранение…", error: "Запись остановлена" };
  el("status").textContent = state.status === "stopping" && state.progress ? state.progress : labels[state.status];
  el("tab").textContent = state.tab ? `Вкладка: ${state.tab.title}` : "Запишется активная вкладка в момент старта";
  el("tab").title = state.tab?.url ?? "";
  el<HTMLProgressElement>("tab-level").value = Math.min(1, state.levels.tab * 5);
  el<HTMLProgressElement>("mic-level").value = Math.min(1, state.levels.mic * 5);
  const active = ["starting", "recording", "stopping"].includes(state.status);
  el<HTMLButtonElement>("start").disabled = active;
  el<HTMLButtonElement>("stop").disabled = state.status !== "recording";
  microphone.disabled = active;
  input("diarization").disabled = active;
  el("diarization-hint").hidden = !input("diarization").checked;
  el("warning").textContent = state.warning ?? (state.diarization && state.status === "recording"
    ? input("show-text").checked ? "Демо: этот текст не сохраняется. Обе дорожки будут обработаны после остановки."
      : "Записывается только аудио. Текст и участники появятся после остановки." : "");
  el("warning").hidden = !el("warning").textContent;
  error(state.error ?? "");
  const text = el("transcript"); text.hidden = !input("show-text").checked;
  if (state.lines.length) {
    text.replaceChildren(...state.lines.map((line) => {
      const row = document.createElement("p");
      const label = document.createElement("strong"); label.textContent = `${line.speaker}: `;
      row.append(label, document.createTextNode(line.text)); return row;
    }));
    text.scrollTop = text.scrollHeight;
  } else {
    const placeholder = document.createElement("p"); placeholder.className = "muted";
    placeholder.textContent = "Текст появится после первого фрагмента речи.";
    text.replaceChildren(placeholder);
  }
}
chrome.runtime.onMessage.addListener((request) => { if (request.target === "popup") render(request.state); });
render(await chrome.runtime.sendMessage({ target: "background", action: "get" }));
for (const id of ["url", "token", "language", "microphone", "show-text", "diarization"]) {
  el(id).addEventListener("change", () => { void save().then(() => current && render(current), (e) => error(e.message)); });
}
el("start").onclick = async () => {
  el<HTMLButtonElement>("start").disabled = true;
  try {
    await save();
    const result = await chrome.runtime.sendMessage({ target: "background", action: "start" });
    if (result?.error) throw new Error(result.error);
  } catch (e) { error(e instanceof Error ? e.message : String(e)); el<HTMLButtonElement>("start").disabled = false; }
};
el("stop").onclick = () => { void chrome.runtime.sendMessage({ target: "background", action: "stop" }).then((result) => { if (result?.error) error(result.error); }); };
el("permission").onclick = () => { void chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") }); };
document.body.inert = false;
setInterval(() => {
  const seconds = current?.startedAt ? Math.floor((Date.now() - current.startedAt) / 1000) : 0;
  if (current?.status !== "recording" && current?.status !== "stopping") return;
  el("elapsed").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}, 500);
