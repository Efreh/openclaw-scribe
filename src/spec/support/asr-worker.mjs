import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
const mode = process.argv[2];
if (mode !== "startup-hang") console.log(JSON.stringify({ type: "ready", maxSeconds: 20 }));
let count = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line); count++;
  if (mode === "crash") process.exit(7);
  if (mode === "hang") continue;
  if (mode === "invalid") { console.log("not json"); continue; }
  if (mode === "error") { console.log(JSON.stringify({ id: request.id, error: "Inference failed" })); continue; }
  const pcmBytes = readFileSync(request.filePath).length - 44;
  console.log(JSON.stringify({ id: request.id, text: [process.pid, count, pcmBytes / 32000, request.language].join(":") }));
}
