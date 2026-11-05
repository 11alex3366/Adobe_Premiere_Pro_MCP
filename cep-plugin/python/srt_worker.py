"""Three-pass local faster-whisper SRT generator for Premiere CEP.

Pass 1 transcribes overlapping 40s windows (2s overlap).
Pass 2 checks overlapping 5s windows (1s overlap) and replaces a region only
when the short-window decode contains more words.
Pass 3 rechecks gaps and words longer than 0.6s using focused 3s windows.
All processing is local; output is one word per SRT cue.
"""
import argparse
import json
import sys

SAMPLE_RATE = 16000


def emit(**payload):
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def format_time(seconds):
    milliseconds = max(0, round(seconds * 1000))
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    seconds, milliseconds = divmod(milliseconds, 1_000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"


def _transcribe_window(model, waveform, start, end, language, segment_offset, priority=0):
    audio = waveform[max(0, int(start * SAMPLE_RATE)):min(len(waveform), int(end * SAMPLE_RATE))]
    if len(audio) == 0:
        return []
    segments, _ = model.transcribe(
        audio, word_timestamps=True, language=language,
        condition_on_previous_text=False, compression_ratio_threshold=2.4,
    )
    result = []
    for segment_index, segment in enumerate(segments):
        for item in segment.words or []:
            text = item.word.strip()
            if not text or item.start is None or item.end is None or item.end <= item.start:
                continue
            word = {
                "start": float(item.start) + start,
                "end": float(item.end) + start,
                "text": text,
                "segment": segment_offset + segment_index,
                "priority": priority,
            }
            probability = getattr(item, "probability", None)
            if isinstance(probability, (int, float)):
                word["probability"] = float(probability)
            result.append(word)
    return result


def _starts(duration, window, overlap):
    stride = max(0.5, window - overlap)
    result, cursor = [], 0.0
    while cursor < duration:
        result.append(cursor)
        if cursor + window >= duration:
            break
        cursor += stride
    return result


def _decode_windows(model, waveform, duration, window, overlap, language, emit_progress, label, priority=0):
    starts = _starts(duration, window, overlap)
    rows = []
    for index, start in enumerate(starts):
        end = min(duration, start + window)
        words = _transcribe_window(model, waveform, start, end, language, index * 100000, priority)
        owner_start = 0.0 if index == 0 else (start + min(duration, starts[index - 1] + window)) / 2.0
        owner_end = duration if index == len(starts) - 1 else (end + starts[index + 1]) / 2.0
        words = [word for word in words if owner_start <= word["start"] < owner_end]
        rows.append((owner_start, owner_end, words))
        emit_progress(type="progress", text=f"{label}: window {index + 1}/{len(starts)} · {len(words)} words.")
    return [word for _, _, words in rows for word in words], rows


def _norm(text):
    return "".join(char.lower() for char in text if char.isalnum())


def _dedupe(words):
    words = sorted(words, key=lambda word: (word["start"], word["end"]))
    result = []
    for word in words:
        if result:
            previous = result[-1]
            same = _norm(previous["text"]) == _norm(word["text"])
            overlap = min(previous["end"], word["end"]) - max(previous["start"], word["start"])
            near = abs(previous["start"] - word["start"]) <= 0.05
            if same and (overlap > 0 or near):
                old_rank = (previous.get("priority", 0), previous.get("probability", 0.0))
                new_rank = (word.get("priority", 0), word.get("probability", 0.0))
                if new_rank > old_rank:
                    result[-1] = word
                continue
        result.append(word)
    return result


def _split_word_rows(words):
    """Guarantee each output record contains exactly one whitespace-delimited word."""
    result = []
    for word in words:
        pieces = word["text"].split()
        if len(pieces) <= 1:
            result.append(word)
            continue
        duration = max(0.001, word["end"] - word["start"])
        weights = [max(1, sum(char.isalnum() for char in piece)) for piece in pieces]
        total = sum(weights)
        cursor = word["start"]
        for index, (piece, weight) in enumerate(zip(pieces, weights)):
            end = word["end"] if index == len(pieces) - 1 else cursor + duration * weight / total
            result.append({**word, "start": cursor, "end": max(cursor + 0.001, end), "text": piece})
            cursor = end
    return result


def _resolve_overlaps_and_gaps(words, duration):
    """Choose one decode when alternatives collide and make word cues gapless."""
    ordered = sorted(_split_word_rows(words), key=lambda word: (word["start"], word["end"]))
    # Resolve near-identical, heavily overlapping ASR alternatives (often emitted
    # when adjacent windows disagree at a boundary). Later focused passes win.
    kept = []
    for word in ordered:
        conflict_index = None
        for index in range(len(kept) - 1, max(-1, len(kept) - 5), -1):
            prior = kept[index]
            if word["start"] - prior["start"] > 0.18:
                break
            overlap = min(word["end"], prior["end"]) - max(word["start"], prior["start"])
            shorter = min(word["end"] - word["start"], prior["end"] - prior["start"])
            if overlap > 0 and shorter > 0 and overlap / shorter >= 0.55:
                conflict_index = index
                break
        if conflict_index is None:
            kept.append(word)
            continue
        prior = kept[conflict_index]
        prior_rank = (prior.get("priority", 0), prior.get("probability", 0.0), len(_norm(prior["text"])))
        word_rank = (word.get("priority", 0), word.get("probability", 0.0), len(_norm(word["text"])))
        if word_rank > prior_rank:
            kept[conflict_index] = word
    kept.sort(key=lambda word: (word["start"], word["end"]))
    if not kept:
        return []
    # Derive adjacent boundaries from word centers. The old pairwise end/start
    # mutation could cascade through overlapping words and create 1ms cues.
    centers = [min(duration, max(0.0, (word["start"] + word["end"]) / 2.0)) for word in kept]
    minimum_spacing = 0.08
    for index in range(1, len(centers)):
        centers[index] = max(centers[index], centers[index - 1] + minimum_spacing)
    if centers[-1] > duration:
        centers[-1] = duration
        for index in range(len(centers) - 2, -1, -1):
            centers[index] = min(centers[index], centers[index + 1] - minimum_spacing)
    centers = [max(0.0, center) for center in centers]
    boundaries = [0.0]
    boundaries.extend((centers[index] + centers[index + 1]) / 2.0 for index in range(len(centers) - 1))
    boundaries.append(duration)
    for index, word in enumerate(kept):
        word["start"] = boundaries[index]
        word["end"] = max(boundaries[index] + 0.001, boundaries[index + 1])
    return kept


def _word_count(words, start, end):
    return sum(1 for word in words if start <= word["start"] < end)


def _merge_better_windows(current, rows):
    replaced = 0
    for start, end, proposed in rows:
        existing_count = _word_count(current, start, end)
        candidate_count = len(proposed)
        if candidate_count <= existing_count:
            continue
        current = [word for word in current if not (start <= word["start"] < end)] + proposed
        replaced += 1
    return _dedupe(current), replaced


def _anomalies(words, duration, max_word_seconds=0.6, gap_seconds=0.6):
    regions = []
    ordered = sorted(words, key=lambda word: word["start"])
    for index, word in enumerate(ordered):
        if word["end"] - word["start"] > max_word_seconds:
            regions.append((max(0.0, word["start"] - 1.0), min(duration, word["end"] + 1.0), "long_word", word["start"], word["end"]))
        if index and word["start"] - ordered[index - 1]["end"] > gap_seconds:
            regions.append((max(0.0, ordered[index - 1]["end"] - 1.0), min(duration, word["start"] + 1.0), "gap", ordered[index - 1]["end"], word["start"]))
    regions.sort()
    merged = []
    for start, end, kind, core_start, core_end in regions:
        if merged and start <= merged[-1][1]:
            prior = merged[-1]
            merged[-1] = (prior[0], max(prior[1], end), prior[2] + "+" + kind, min(prior[3], core_start), max(prior[4], core_end))
        else:
            merged.append((start, end, kind, core_start, core_end))
    # The opening audio is explicitly rechecked on every job: the baseline can
    # start at 0 after timeline normalization even when Whisper missed speech.
    if duration > 0:
        merged.append((0.0, min(duration, 5.0), "leading_recheck", 0.0, min(duration, 5.0)))
    return merged


def _target_windows(regions, duration, window=3.0):
    windows = []
    for start, end, kind, core_start, core_end in regions:
        cursor = start
        while cursor < end:
            window_end = min(end, cursor + window)
            if window_end - cursor < 0.5:
                cursor = max(start, window_end - 0.5)
                window_end = min(end, cursor + 0.5)
            windows.append((cursor, window_end, kind, max(core_start, cursor), min(core_end, window_end)))
            if window_end >= end:
                break
            cursor += window - 0.5
    return windows


def _write_srt(path, words):
    with open(path, "w", encoding="utf-8-sig", newline="\n") as output:
        for index, word in enumerate(sorted(words, key=lambda row: (row["start"], row["end"])), 1):
            if len(word["text"].split()) != 1:
                raise RuntimeError(f"Word-level output validation failed at cue {index}: expected exactly one word.")
            if word["end"] <= word["start"]:
                raise RuntimeError(f"Word-level output validation failed at cue {index}: invalid timing.")
            output.write(f"{index}\n{format_time(word['start'])} --> {format_time(word['end'])}\n{word['text']}\n\n")


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
    parser.add_argument("--metadata-out", default="")
    args = parser.parse_args()
    try:
        from faster_whisper import WhisperModel
        from faster_whisper.audio import decode_audio
    except ImportError:
        emit(type="error", message="faster-whisper is missing. Install it with: python -m pip install faster-whisper")
        return 1
    try:
        compute = args.compute or ("int8" if args.device == "cpu" else "float16")
        emit(type="progress", text=f"Loading Whisper model {args.model} on {args.device}…")
        model = WhisperModel(args.model, device=args.device, compute_type=compute)
        language = None if args.lang in ("", "auto") else args.lang
        emit(type="progress", text="Decoding exported audio locally…")
        waveform = decode_audio(args.audio)
        duration = len(waveform) / SAMPLE_RATE
        if duration <= 0:
            raise RuntimeError("The exported audio is empty.")

        emit(type="progress", text="Pass 1/3: transcribing 40-second windows with 2-second overlap…")
        words, _ = _decode_windows(model, waveform, duration, 40.0, 2.0, language, emit, "Pass 1/3", priority=0)
        words = _dedupe(words)
        if not words:
            raise RuntimeError("Whisper returned no word timestamps in pass 1.")
        first_pass_count = len(words)

        emit(type="progress", text="Pass 2/3: checking 5-second windows with 1-second overlap…")
        _, short_rows = _decode_windows(model, waveform, duration, 5.0, 1.0, language, emit, "Pass 2/3", priority=1)
        words, second_replacements = _merge_better_windows(words, short_rows)

        emit(type="progress", text="Pass 3/3: rechecking word gaps and words longer than 0.6 seconds…")
        regions = _anomalies(words, duration)
        targets = _target_windows(regions, duration)
        third_replacements = 0
        for index, (start, end, kind, core_start, core_end) in enumerate(targets):
            proposed = _transcribe_window(model, waveform, start, end, language, 300000 + index * 1000, priority=2)
            proposed_core = [word for word in proposed if core_start - 0.05 <= (word["start"] + word["end"]) / 2.0 <= core_end + 0.05]
            existing_core = [word for word in words if core_start <= (word["start"] + word["end"]) / 2.0 <= core_end]
            replace_core = False
            if "long_word" in kind:
                # A flagged long cue is replaced by its focused decode when that
                # decode splits it into multiple words, even if the surrounding
                # 3-second region has fewer total words than the original.
                long_cues = [word for word in existing_core if word["end"] - word["start"] > 0.6]
                replace_core = bool(long_cues and len(proposed_core) > len(long_cues))
            elif kind == "gap":
                replace_core = len(proposed_core) > len(existing_core)
            elif kind == "leading_recheck":
                replace_core = len(proposed_core) > len(existing_core)
            if replace_core:
                words = _dedupe([word for word in words if not (core_start <= (word["start"] + word["end"]) / 2.0 <= core_end)] + proposed_core)
                third_replacements += 1
            emit(type="progress", text=f"Pass 3/3: checked region {index + 1}/{len(targets)} ({kind}).")

        words = _resolve_overlaps_and_gaps(words, duration)
        words = sorted(words, key=lambda word: (word["start"], word["end"]))
        # Word-level SRT is required by retake analysis and the user's output spec.
        _write_srt(args.out, words)
        if args.metadata_out:
            with open(args.metadata_out, "w", encoding="utf-8") as metadata:
                json.dump({
                    "words": words,
                    "transcription": {
                        "passes": 3,
                        "firstPassWindowSeconds": 40,
                        "firstPassOverlapSeconds": 2,
                        "secondPassWindowSeconds": 5,
                        "secondPassOverlapSeconds": 1,
                        "thirdPassWindowSeconds": 3,
                        "thirdPassMaxWordSeconds": 0.6,
                        "secondPassWindowsReplaced": second_replacements,
                        "thirdPassWindowsReplaced": third_replacements,
                        "thirdPassRegions": len(regions),
                        "thirdPassWindows": len(targets),
                        "firstPassWords": first_pass_count,
                        "finalWords": len(words),
                        "audioDurationSeconds": duration,
                    },
                }, metadata, ensure_ascii=False)
        emit(type="done", words=len(words), subtitles=len(words), output=args.out,
             passes=3, secondPassWindowsReplaced=second_replacements,
             thirdPassWindowsReplaced=third_replacements, thirdPassRegions=len(regions),
             audioDurationSeconds=duration)
        return 0
    except Exception as error:
        emit(type="error", message=str(error))
        return 1


if __name__ == "__main__":
    sys.exit(main())
