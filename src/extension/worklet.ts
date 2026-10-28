import { CHUNK_SECONDS } from "../shared/protocol.ts";

declare const sampleRate: number;
declare class AudioWorkletProcessor { port: MessagePort; }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class Recorder extends AudioWorkletProcessor {
  buffer = new Int16Array(sampleRate * CHUNK_SECONDS);
  used = 0;
  frames = 0;
  meterFrames = 0;
  meterEnergy = 0;
  constructor() {
    super();
    this.port.onmessage = () => { this.flush(); this.port.postMessage({ type: "flushed" }); };
  }
  flush() {
    if (!this.used) return;
    const pcm = this.buffer.slice(0, this.used);
    this.port.postMessage({ type: "audio", samples: pcm, offsetMs: Math.round((this.frames - this.used) / sampleRate * 1000) }, [pcm.buffer]);
    this.used = 0;
  }
  process(inputs: Float32Array[][]) {
    const channels = inputs[0];
    const length = channels?.[0]?.length ?? 0;
    for (let i = 0; i < length; i++) {
      let value = 0;
      for (const channel of channels!) value += channel[i]! / channels!.length;
      value = Math.max(-1, Math.min(1, value));
      this.buffer[this.used++] = Math.round(value < 0 ? value * 32768 : value * 32767);
      this.frames++;
      this.meterEnergy += value * value;
      this.meterFrames++;
      if (this.used === this.buffer.length) this.flush();
    }
    if (this.meterFrames >= sampleRate / 5) {
      this.port.postMessage({ type: "level", value: Math.sqrt(this.meterEnergy / this.meterFrames) });
      this.meterFrames = 0; this.meterEnergy = 0;
    }
    return true; // Outputs stay silent: microphone monitoring would cause feedback.
  }
}
registerProcessor("scribe-recorder", Recorder);
