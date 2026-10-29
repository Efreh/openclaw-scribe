import { settings } from "./state.ts";
import type { Settings, State } from "./state.ts";
import { validateEndpoint } from "../shared/protocol.ts";

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
let config: Settings = await settings();
let current: State;
let activeTab = "Активная вкладка в момент старта";
let localError = "";
let openingFolder = false;
let microphonePermission = false;

for (const key of ["url", "token", "language"] as const) input(key).value = config[key];
input("show-text").checked = config.showText;
input("diarization").checked = config.diarization;
input("save-audio").checked = config.saveAudio;
input("use-mic").checked = config.microphone !== "none";
el<HTMLDetailsElement>("connection").open = !config.token;
const microphone = el<HTMLSelectElement>("microphone");
try {
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const device of devices.filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default")) {
    microphone.add(new Option(device.label || "Микрофон", device.deviceId));
  }
  microphonePermission = (await navigator.permissions.query({ name: "microphone" as PermissionName })).state === "granted";
} catch { /* Device names and permission status can be unavailable before consent. */ }
const selected = config.microphone === "none" ? config.lastMicrophone : config.microphone;
microphone.value = selected;
if (!microphone.value) { microphone.add(new Option("Выбранное устройство недоступно", selected)); microphone.value = selected; }
try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.title && /^https?:/.test(tab.url ?? "")) activeTab = tab.title;
} catch { /* Active tab will be resolved authoritatively by the service worker at start. */ }

function theme() {
  const dark = config.theme !== "light";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  el("theme").setAttribute("aria-label", dark ? "Включить светлую тему" : "Включить тёмную тему");
  el("theme").title = dark ? "Светлая тема" : "Тёмная тема";
  el("theme-icon").setAttribute("href", dark ? "#i-sun" : "#i-moon");
}
theme();

async function save() {
  const updated: Settings = {
    ...config, url: validateEndpoint(input("url").value.trim()), token: input("token").value.trim(),
    language: input("language").value.trim(), microphone: input("use-mic").checked ? microphone.value : "none",
    lastMicrophone: microphone.value, showText: input("show-text").checked,
    diarization: input("diarization").checked, saveAudio: input("save-audio").checked,
  };
  if (!/^[a-z]{2,3}$/.test(updated.language)) throw new Error("Код языка: ru, en и т. п.");
  await chrome.storage.local.set({ settings: updated });
  config = updated;
  localError = "";
}
function error(value: string) { el("error").textContent = value; el("error").hidden = !value; }
function elapsed() {
  const seconds = current?.startedAt ? Math.max(0, Math.floor(((current.endedAt ?? Date.now()) - current.startedAt) / 1000)) : 0;
  el("elapsed").textContent = String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
}
function render(state: State) {
  current = state;
  document.body.dataset.status = state.status;
  const active = ["starting", "recording", "stopping"].includes(state.status);
  const completed = state.status === "done";
  const full = active ? Boolean(state.fullRecording) : config.diarization || config.saveAudio;
  const demo = state.status === "recording" && full;
  const labels = { idle: "Готово к записи", starting: "Подключение…", recording: "Идёт запись",
    stopping: "Распознавание и сохранение…", done: "Запись готова", error: "Запись не завершена" };
  el("status").textContent = state.status === "stopping" && state.progress ? state.progress : labels[state.status];
  el("elapsed").hidden = !state.startedAt;
  elapsed();
  el("completion-hint").hidden = !completed;
  el("setup").hidden = active || completed;
  el("tab").textContent = state.tab?.title ?? activeTab;
  el("tab").title = state.tab?.url ?? "";
  el("recording-params").hidden = !active;
  el("recording-source").textContent = (state.tab?.title ?? activeTab) + " · " + (state.microphone === "none" ? "Без микрофона" : "Микрофон включён");
  el("recording-mode").textContent = (state.diarization ? "Разделение говорящих" : "Без разделения говорящих")
    + " · " + (state.saveAudio ? "Аудио сохраняется" : "Без сохранения аудио");
  el("levels").hidden = state.status !== "recording";
  el("mic-meter").hidden = state.microphone === "none";
  el<HTMLProgressElement>("tab-level").value = Math.min(1, state.levels.tab * 5);
  el<HTMLProgressElement>("mic-level").value = Math.min(1, state.levels.mic * 5);
  for (const id of ["diarization", "save-audio", "use-mic", "url", "token", "language"]) input(id).disabled = active;
  microphone.disabled = active || !input("use-mic").checked;
  el("permission").hidden = active || !input("use-mic").checked || microphonePermission;
  input("show-text").disabled = state.status === "starting" || state.status === "stopping";
  el<HTMLButtonElement>("start").disabled = active;
  el("start").hidden = active || completed;
  el<HTMLButtonElement>("stop").disabled = state.status !== "recording";
  el("stop").hidden = state.status !== "recording";
  el("busy").hidden = state.status !== "starting" && state.status !== "stopping";
  el("busy").textContent = state.status === "starting" ? "Подключение…" : "Готовим стенограмму…";
  el("new").hidden = !completed;
  const hasAudio = Boolean(state.audio?.files.length);
  el("open-folder").hidden = !hasAudio;
  el<HTMLButtonElement>("open-folder").disabled = active || openingFolder;
  el("new").className = hasAudio ? "secondary" : "primary";
  el("audio-files").hidden = !hasAudio;
  el("audio-heading").textContent = state.audio?.recovery ? "Аудио для восстановления" : "Сохранённые файлы";
  el("audio-location").textContent = hasAudio ? "На компьютере OpenClaw · " + state.audio!.directory : "";
  el("files").replaceChildren(...(state.audio?.files ?? []).map((channel) => {
    const li = document.createElement("li");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use"); use.setAttribute("href", "#i-file"); icon.append(use);
    li.append(icon, document.createTextNode(channel === "tab" ? "tab.wav — вкладка" : "mic.wav — микрофон")); return li;
  }));
  el("mode-hint").textContent = state.status === "stopping" ? "Обработка продолжится, если закрыть это окно."
    : completed ? (input("show-text").checked ? "" : "Стенограмма и итоги доступны во «Встречах» OpenClaw.")
    : state.status === "error" ? ""
    : full ? "Текст будет готов после завершения записи. Предпросмотр не сохраняется."
    : "Текст распознаётся и сохраняется во время записи.";
  el("warning").textContent = state.warning ?? "";
  el("warning").hidden = !state.warning;
  error(localError || state.error || "");
  el("transcript-title").textContent = demo ? "Предпросмотр" : completed ? "Стенограмма" : "Текст записи";
  el("demo-label").hidden = !demo;
  el("transcript-block").hidden = !input("show-text").checked;
  const text = el("transcript");
  if (state.lines.length) {
    text.replaceChildren(...state.lines.map((line) => {
      const row = document.createElement("p");
      const label = document.createElement("strong"); label.textContent = line.speaker;
      row.append(label, document.createTextNode(line.text)); return row;
    }));
    text.scrollTop = text.scrollHeight;
  } else {
    const placeholder = document.createElement("p"); placeholder.className = "placeholder";
    placeholder.textContent = state.status === "stopping" ? "Обрабатываем записанное аудио…"
      : state.status === "error" ? "Итоговый текст недоступен. Проверьте сообщение об ошибке."
      : completed ? "В записи не найдено распознанной речи."
      : full && state.status !== "recording" ? "Здесь будет одноразовый предпросмотр речи."
      : "Текст появится после первого фрагмента речи.";
    text.replaceChildren(placeholder);
  }
  el("connection-state").textContent = state.status === "recording" || state.status === "stopping" ? "OpenClaw подключён"
    : completed ? "Сохранено в OpenClaw" : config.token ? "Локальное подключение настроено" : "Настройте подключение к OpenClaw";
}

chrome.runtime.onMessage.addListener((request) => { if (request.target === "popup") render(request.state); });
render(await chrome.runtime.sendMessage({ target: "background", action: "get" }));
for (const id of ["url", "token", "language", "microphone", "show-text", "diarization", "save-audio", "use-mic"]) {
  el(id).addEventListener("change", () => {
    void save().then(() => current && render(current), (e) => { localError = e.message; error(localError); });
  });
}
el("theme").onclick = async () => {
  config = { ...config, theme: config.theme === "light" ? "dark" : "light" };
  theme();
  await chrome.storage.local.set({ settings: config });
};
el("settings").onclick = () => { el<HTMLDetailsElement>("connection").open = !el<HTMLDetailsElement>("connection").open; };
el("connection").ontoggle = () => { el("settings").setAttribute("aria-expanded", String(el<HTMLDetailsElement>("connection").open)); };
el("start").onclick = async () => {
  el<HTMLButtonElement>("start").disabled = true;
  try {
    await save();
    const result = await chrome.runtime.sendMessage({ target: "background", action: "start" });
    if (result?.error) throw new Error(result.error);
  } catch (e) { localError = e instanceof Error ? e.message : String(e); error(localError); el<HTMLButtonElement>("start").disabled = false; }
};
el("stop").onclick = () => {
  void chrome.runtime.sendMessage({ target: "background", action: "stop" }).then((result) => {
    if (result?.error) { localError = result.error; error(localError); }
  });
};
el("new").onclick = async () => { localError = ""; render(await chrome.runtime.sendMessage({ target: "background", action: "reset" })); };
el("open-folder").onclick = async () => {
  openingFolder = true; localError = ""; render(current);
  try {
    const result = await chrome.runtime.sendMessage({ target: "background", action: "open-recording" });
    if (result?.error) throw new Error(result.error);
  } catch (e) { localError = e instanceof Error ? e.message : String(e); }
  finally { openingFolder = false; render(current); }
};
el("permission").onclick = () => { void chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") }); };
document.body.inert = false;
setInterval(elapsed, 500);
