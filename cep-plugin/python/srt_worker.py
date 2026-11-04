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
    parser.add_argument("--audio", default="")
    parser.add_argument("--jobs-manifest", default="", help="JSON manifest with separately exported sequence clips and timeline offsets.")
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--lang", default="auto")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--compute", default="")
    parser.add_argument("--words-per-subtitle", type=int, default=1)
    parser.add_argument("--metadata-out", default="", help="Optional JSON output with word timestamps and Whisper confidence values.")
    args = parser.parse_args()
    args.words_per_subtitle = max(1, min(15, args.words_per_subtitle))
    if not args.audio and not args.jobs_manifest:
        parser.error("provide --audio or --jobs-manifest")
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        emit(type="error", message="faster-whisper is missing. Install it with: python -m pip install faster-whisper")
        return 1
    try:
        compute = args.compute or ("int8" if args.device == "cpu" else "float16")
        emit(type="progress", text=f"Loading Whisper model {args.model} on {args.device}…")
        model = WhisperModel(args.model, device=args.device, compute_type=compute)
        language = None if args.lang in ("", "auto") else args.lang
        words = []
        audio_segments = []
        jobs = []
        if args.jobs_manifest:
            with open(args.jobs_manifest, "r", encoding="utf-8") as manifest_file:
                manifest = json.load(manifest_file)
            jobs = manifest.get("jobs", [])
            if not isinstance(jobs, list) or not jobs:
                raise RuntimeError("The clip export manifest contains no jobs.")
        else:
            jobs = [{"audio": args.audio, "offset": 0, "name": "audio"}]

        combined_captions = []
        global_segment_offset = 0
        for job_index, job in enumerate(jobs):
            audio_path = job.get("audio")
            offset = float(job.get("offset") or 0)
            if not audio_path:
                raise RuntimeError(f"Clip {job_index + 1} has no audio path.")
            emit(type="progress", text=f"Transcribing clip {job_index + 1}/{len(jobs)} locally…")
            segments, _ = model.transcribe(audio_path, word_timestamps=True, language=language)
            local_words = []
            local_audio_segments = []
            segment_count = 0
            for segment_index, segment in enumerate(segments):
                segment_count += 1
                segment_words = []
                for item in segment.words or []:
                    text = item.word.strip()
                    if text and item.start is not None and item.end is not None:
                        probability = getattr(item, "probability", None)
                        word = {"start": item.start, "end": item.end, "text": text, "segment": global_segment_offset + segment_index}
                        if isinstance(probability, (int, float)):
                            word["probability"] = float(probability)
                        local_words.append(word)
                        segment_words.append(word)
                if segment_words:
                    local_audio_segments.append({
                        "start": segment.start + offset,
                        "end": segment.end + offset,
                        "text": segment.text,
                        "avg_logprob": getattr(segment, "avg_logprob", None),
                        "no_speech_prob": getattr(segment, "no_speech_prob", None),
                        "word_count": len(segment_words),
                        "clip_index": job_index + 1,
                    })
            global_segment_offset += max(segment_count, 1)
            if not local_words:
                emit(type="progress", text=f"Clip {job_index + 1}/{len(jobs)} contained no recognized speech; skipped.")
                continue

            local_captions = captions_from_words(local_words, args.words_per_subtitle)
            clip_out = f"{args.out}.clip-{job_index + 1:04}.srt"
            with open(clip_out, "w", encoding="utf-8-sig", newline="\n") as clip_file:
                for cue_index, caption in enumerate(local_captions, 1):
                    clip_file.write(f"{cue_index}\n{format_time(caption['start'])} --> {format_time(caption['end'])}\n{caption['text']}\n\n")

            for word in local_words:
                absolute_word = dict(word)
                absolute_word["start"] += offset
                absolute_word["end"] += offset
                words.append(absolute_word)
            audio_segments.extend(local_audio_segments)
            combined_captions.extend(captions_from_words([
                {**word, "start": word["start"] + offset, "end": word["end"] + offset}
                for word in local_words
            ], args.words_per_subtitle))

        if not words:
            raise RuntimeError("Whisper returned no word timestamps for any exported clip.")
        combined_captions.sort(key=lambda cue: (cue["start"], cue["end"]))
        with open(args.out, "w", encoding="utf-8-sig", newline="\n") as output:
            for index, caption in enumerate(combined_captions, 1):
                output.write(f"{index}\n{format_time(caption['start'])} --> {format_time(caption['end'])}\n{caption['text']}\n\n")
        if args.metadata_out:
            with open(args.metadata_out, "w", encoding="utf-8") as metadata:
                json.dump({"words": words, "segments": audio_segments}, metadata, ensure_ascii=False)
        emit(type="done", words=len(words), subtitles=len(combined_captions), clips=len(jobs), output=args.out)
        return 0
    except Exception as error:
        emit(type="error", message=str(error))
        return 1


if __name__ == "__main__":
    sys.exit(main())
