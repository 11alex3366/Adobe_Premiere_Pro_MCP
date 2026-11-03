"""Local faster-whisper worker used by the Premiere CEP panel.

Usage: python srt_worker.py --audio input.mp3 --out output.srt
Progress and errors are newline-delimited JSON on stdout; audio never leaves this PC.
"""
import argparse
import json
import sys


def emit(**payload):
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def format_time(seconds):
    milliseconds = max(0, round(seconds * 1000))
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    seconds, milliseconds = divmod(milliseconds, 1_000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"


def captions_from_words(words, words_per_subtitle, max_gap=0.8):
    """Group Whisper word timestamps without crossing Whisper segments or long pauses."""
    result, current = [], None
    for word in words:
        if current and (
            current["count"] >= words_per_subtitle
            or word["segment"] != current["segment"]
            or word["start"] - current["end"] > max_gap
        ):
            result.append(current)
            current = None
        if current is None:
            current = {
                "start": word["start"], "end": word["end"], "text": word["text"],
                "segment": word["segment"], "count": 1,
            }
        else:
            current["end"] = word["end"]
            current["text"] += " " + word["text"]
            current["count"] += 1
    if current:
        result.append(current)
    return result


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--lang", default="auto")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--compute", default="")
    parser.add_argument("--words-per-subtitle", type=int, default=1)
    parser.add_argument("--metadata-out", default="", help="Optional JSON output with word timestamps and Whisper confidence values.")
    args = parser.parse_args()
    args.words_per_subtitle = max(1, min(15, args.words_per_subtitle))
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        emit(type="error", message="faster-whisper is missing. Install it with: python -m pip install faster-whisper")
        return 1
    try:
        compute = args.compute or ("int8" if args.device == "cpu" else "float16")
        emit(type="progress", text=f"Loading Whisper model {args.model} on {args.device}…")
        model = WhisperModel(args.model, device=args.device, compute_type=compute)
        emit(type="progress", text="Transcribing audio locally…")
        language = None if args.lang in ("", "auto") else args.lang
        segments, _ = model.transcribe(args.audio, word_timestamps=True, language=language)
        words = []
        audio_segments = []
        for segment_index, segment in enumerate(segments):
            segment_words = []
            for item in segment.words or []:
                text = item.word.strip()
                if text and item.start is not None and item.end is not None:
                    probability = getattr(item, "probability", None)
                    word = {"start": item.start, "end": item.end, "text": text, "segment": segment_index}
                    if isinstance(probability, (int, float)):
                        word["probability"] = float(probability)
                    words.append(word)
                    segment_words.append(word)
            if segment_words:
                audio_segments.append({
                    "start": segment.start,
                    "end": segment.end,
                    "text": segment.text,
                    "avg_logprob": getattr(segment, "avg_logprob", None),
                    "no_speech_prob": getattr(segment, "no_speech_prob", None),
                    "word_count": len(segment_words),
                })
            emit(type="progress", text=f"Transcribed through {segment.end:.0f} seconds…")
        if not words:
            raise RuntimeError("Whisper returned no word timestamps for this audio.")
        captions = captions_from_words(words, args.words_per_subtitle)
        with open(args.out, "w", encoding="utf-8-sig", newline="\n") as output:
            for index, caption in enumerate(captions, 1):
                output.write(f"{index}\n{format_time(caption['start'])} --> {format_time(caption['end'])}\n{caption['text']}\n\n")
        if args.metadata_out:
            with open(args.metadata_out, "w", encoding="utf-8") as metadata:
                json.dump({"words": words, "segments": audio_segments}, metadata, ensure_ascii=False)
        emit(type="done", words=len(words), subtitles=len(captions), output=args.out)
        return 0
    except Exception as error:
        emit(type="error", message=str(error))
        return 1


if __name__ == "__main__":
    sys.exit(main())
