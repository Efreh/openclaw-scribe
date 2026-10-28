import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeAudio, encodeAudio, parseHello, validateEndpoint, wav } from "../../shared/protocol.ts";

test("binary audio preserves channel, boundaries, sequence and sample offsets", () => {
  for (const channel of ["tab", "mic"] as const) {
    const chunk = { channel, sequence: 42, offsetMs: 90_000, samples: new Int16Array([-32768, -1, 0, 1, 32767]) };
    const encoded = new Uint8Array(encodeAudio(chunk));
    const withPadding = new Uint8Array(encoded.length + 4);
    withPadding.set(encoded, 2);
    assert.deepEqual(decodeAudio(withPadding.subarray(2, -2)), chunk);
    const wave = wav(chunk.samples);
    assert.equal(new TextDecoder().decode(wave.subarray(0, 4)), "RIFF");
    assert.equal(new DataView(wave.buffer).getUint32(24, true), 16_000);
    assert.equal(new DataView(wave.buffer).getUint32(40, true), 10);
    assert.equal(new DataView(wave.buffer).getInt16(44, true), -32768);
  }
});

test("untrusted wire data is rejected before allocation or transcription", () => {
  for (const bytes of [new Uint8Array(0), new Uint8Array(11), new Uint8Array(700_000)]) assert.throws(() => decodeAudio(bytes));
  const bytes = new Uint8Array(encodeAudio({ channel: "tab", sequence: 0, offsetMs: 0, samples: new Int16Array(2) }));
  bytes[1] = 8; assert.throws(() => decodeAudio(bytes));
  assert.throws(() => parseHello({ type: "start", version: 2 }));
  assert.throws(() => parseHello({ type: "start", version: 1, token: "x", title: "a", url: "", language: "ru;sh" }));
});

test("connection settings stay loopback-only and never put credentials in URLs", () => {
  assert.equal(validateEndpoint("ws://127.0.0.1:19789"), "ws://127.0.0.1:19789/");
  for (const url of ["ws://example.com", "ws://127.0.0.1.evil.test", "ws://user:secret@localhost", "ws://localhost/?token=x", "http://localhost", "ws://localhost/private"]) {
    assert.throws(() => validateEndpoint(url));
  }
});
