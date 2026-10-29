"""Official GigaAM runtime behind Scribe's generic resident JSONL adapter (MIT)."""
import argparse
import json
import sys
import wave
from pathlib import Path

# Reserve stdout for protocol; vendor imports/progress must not corrupt JSONL.
protocol = sys.stdout
sys.stdout = sys.stderr


def emit(value):
    protocol.write(json.dumps(value, ensure_ascii=False) + "\n")
    protocol.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--threads", type=int, default=6)
    args = parser.parse_args()
    checkpoint = Path(args.model_dir) / "multilingual_large_ctc.ckpt"
    if not checkpoint.is_file():
        raise FileNotFoundError("Install the official multilingual_large_ctc checkpoint first")
    import torch
    import gigaam

    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    device = ("cuda" if torch.cuda.is_available() else "cpu") if args.device == "auto" else args.device
    # Official loader checks its pinned MD5; existing file means no download.
    model = gigaam.load_model("multilingual_large_ctc", fp16_encoder=True,
                             use_flash=False, device=device, download_root=str(checkpoint.parent))
    emit({"type": "ready", "model": "multilingual_large_ctc", "device": device, "maxSeconds": 25})
    for line in sys.stdin:
        request = json.loads(line)
        try:
            path = request["filePath"]
            with wave.open(path, "rb") as audio:
                if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, 16000):
                    raise ValueError("Expected mono PCM16 16 kHz WAV")
                if audio.getnframes() > 25 * 16000:
                    raise ValueError("GigaAM short-form limit is 25 seconds")
            # CTC is multilingual; language is not a forced decoder option.
            with torch.inference_mode():
                result = model.transcribe(path)
            emit({"id": request["id"], "text": result.text})
        except Exception as error:
            emit({"id": request["id"], "error": "GigaAM inference failed: " + type(error).__name__})


if __name__ == "__main__":
    main()
