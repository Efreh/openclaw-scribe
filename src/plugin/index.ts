import { randomBytes } from "node:crypto";
import { access, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { wav } from "../shared/protocol.ts";
import { createScribe } from "./server.ts";
import { createDiarizationSession, defaultDiarizationCommand, diarizeFile, prepareDiarization } from "./diarization.ts";
import type { DiarizationConfig } from "./diarization.ts";

export async function pairingToken(stateDir: string): Promise<string> {
  const dir = join(stateDir, "scribe");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "pairing-token");
  const temporary = join(dir, `.token-${randomBytes(8).toString("hex")}`);
  await writeFile(temporary, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
  try { await link(temporary, file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  finally { await rm(temporary, { force: true }); }
  const token = (await readFile(file, "utf8")).trim();
  if (!/^[\w-]{43}$/.test(token)) throw new Error("Invalid Scribe pairing token file");
  return token;
}

export function localAudioConfig(cfg: OpenClawConfig): OpenClawConfig {
  const media = cfg.tools?.media;
  const models = (media?.models ?? [])
    .filter((model) => model.type === "cli" && (!model.capabilities || model.capabilities.includes("audio")));
  if (!models.length) throw new Error("Configure a local audio CLI (Whisper) in OpenClaw tools.media first");
  return { ...cfg, tools: { ...cfg.tools, media: {
    ...media, models, audio: { ...media?.audio, enabled: true },
  } } };
}

export default definePluginEntry({
  id: "openclaw-scribe", name: "OpenClaw Scribe", description: "Local browser audio → native OpenClaw meeting transcripts",
  register(api) {
    const port = Number(api.pluginConfig?.port ?? 19789);
    const diarization = api.pluginConfig?.diarization as DiarizationConfig | undefined;
    let service: ReturnType<typeof createScribe> | undefined;
    // Registration is inert: sockets and files are opened only by the service/CLI lifecycle.
    const provider: Parameters<typeof api.registerTranscriptSourceProvider>[0] = {
      id: "openclaw-scribe", name: "OpenClaw Scribe", sourceKinds: ["live-audio"],
      start: (request) => service?.provider.start!(request) ?? Promise.resolve({ ok: false, error: "Scribe service not running" }),
      stop: (request) => service?.provider.stop!(request) ?? Promise.resolve({ ok: true, sessionId: request.sessionId }),
      watchOccupancy: (request) => service?.provider.watchOccupancy!(request) ?? Promise.resolve({ ok: false, error: "Scribe service not ready" }),
      status: (source) => service?.provider.status!(source) ?? Promise.resolve([{ source, active: false }]),
    };
    api.registerTranscriptSourceProvider(provider);
    api.registerService({
      id: "openclaw-scribe",
      async start(ctx) {
        const audioConfig = localAudioConfig(ctx.config);
        const workDir = join(ctx.stateDir, "scribe", "work");
        await mkdir(workDir, { recursive: true, mode: 0o700 });
        service = createScribe({
          port, token: await pairingToken(ctx.stateDir),
          extensionIds: api.pluginConfig?.extensionIds as string[] | undefined,
          warn: (text) => ctx.logger.warn(text),
          createDiarization: diarization ? async (hello, sessionId) => {
            await access(diarization.model);
            return createDiarizationSession({ workDir, sessionId, language: hello.language,
              diarize: (path, duration) => diarizeFile(diarization, path, duration) });
          } : undefined,
          async transcribe(chunk, language) {
            const dir = await mkdtemp(join(workDir, "chunk-"));
            try {
              const filePath = join(dir, "audio.wav");
              await writeFile(filePath, wav(chunk.samples), { mode: 0o600 });
              const result = await api.runtime.mediaUnderstanding.transcribeAudioFile({
                filePath, cfg: audioConfig, mime: "audio/wav", language,
              });
              if (result.text === undefined) throw new Error("Local transcription returned no result");
              return result.text;
            } finally { await rm(dir, { recursive: true, force: true }); }
          },
        });
        await service.start();
        ctx.logger.info(`Scribe listening on ws://127.0.0.1:${port}`);
      },
      async stop() { await service?.stop(); service = undefined; },
    });
    api.registerCli(({ program }) => {
      const command = program.command("scribe").description("Set up the browser recorder");
      command.command("pair").description("Print the local extension connection settings").action(async () => {
        // Explicit local credential export: console.log is captured and redacted by OpenClaw.
        // Write only this command's result directly; keep credentials out of host log files.
        process.stdout.write(`${JSON.stringify({ url: `ws://127.0.0.1:${port}`, token: await pairingToken(api.runtime.state.resolveStateDir()) }, null, 2)}\n`);
      });
      command.command("setup").description("Enable the native transcript source; preserve other sources")
        .option("--diarization", "Prepare the native Nemotron diarizer (nemo-speech must be installed)")
        .action(async (options: { diarization?: boolean }) => {
        const prepared = options.diarization ? await prepareDiarization(diarization?.command ?? await defaultDiarizationCommand()) : undefined;
        await api.runtime.config.mutateConfigFile({
          afterWrite: { mode: "auto" },
          mutate(draft) {
            if (prepared) {
              draft.plugins ??= {};
              draft.plugins.entries ??= {};
              const entry = draft.plugins.entries["openclaw-scribe"] ??= {};
              entry.config = { ...entry.config, diarization: { ...prepared, device: diarization?.device ?? prepared.device } };
            }
            draft.transcripts ??= {};
            draft.transcripts.enabled = true;
            const sources = draft.transcripts.autoStart ??= [];
            const existing = sources.filter((source) => source.providerId === "openclaw-scribe");
            if (existing.length > 1) throw new Error("Keep only one openclaw-scribe transcript source before setup");
            if (existing[0]) { existing[0].whenOccupied = true; delete existing[0].sessionId; }
            else {
              sources.push({ providerId: "openclaw-scribe", whenOccupied: true });
            }
          },
        });
        console.log("Scribe source configured. Restart the Gateway, then run: openclaw scribe pair");
      });
    }, { commands: ["scribe"] });
  },
});
