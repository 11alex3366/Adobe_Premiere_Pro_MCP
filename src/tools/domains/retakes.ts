import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import type { ToolContext, ToolModule } from '../context.js';
import { generateSrtForRange } from './srt.js';
import { removeRangesDetailedForWorkflow } from './range.js';

type Cue = { start: number; end: number; text: string };
type Take = { start: number; end: number; text: string; words: string[]; score: number; whisperConfidence?: number };
type RetakeGroup = { id: number; takes: Take[]; best: Take | null };
type RemoveRequest = { start_time: number; end_time: number; groupId?: number };

async function saveRetakePlan(
  srtPath: string,
  activeSequence: unknown,
  activeSequenceId: string,
  range: { start_time: number; end_time: number },
  groups: RetakeGroup[],
): Promise<{ planPath: string; removeRangeCalls: RemoveRequest[] }> {
  const confident = groups.filter((group) => group.best);
  const removeRangeCalls = confident.flatMap((group) => group.takes
    .filter((take) => take !== group.best)
    .map((take) => ({ start_time: range.start_time + take.start, end_time: range.start_time + take.end, groupId: group.id })))
    .sort((a, b) => b.start_time - a.start_time);
  const planPath = `${srtPath}.remove-retakes.json`;
  const plan = {
    version: 1,
    activeSequence,
    activeSequenceId,
    range,
    srtPath,
    groups: groups.map((group) => ({
      id: group.id,
      bestTake: group.best ? { start_time: range.start_time + group.best.start, end_time: range.start_time + group.best.end, text: group.best.text } : null,
      takes: group.takes.map((take) => ({ start_time: range.start_time + take.start, end_time: range.start_time + take.end, text: take.text })),
      confidence: group.best ? 'accepted' : 'uncertain',
    })),
    remove_range_calls: removeRangeCalls.map(({ start_time, end_time }) => ({ start_time, end_time })),
  };
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return { planPath, removeRangeCalls };
}

let removeRetakesInFlight = false;

export const retakeTools: ToolModule[] = [{
  name: 'remove_retakes',
  description: 'Generates a local word-level SRT from the active sequence In/Out range, detects confidently repeated takes from transcript and timing, and removes rejected takes through the existing native remove_range operation. Requires start_time and end_time in seconds. Optionally set timeout_seconds to 45, 60, or 90 (default 45). Ambiguous groups are left untouched.',
  inputSchema: z.object({
    start_time: z.number().finite().min(0).describe('Analysis In point in seconds from the active sequence start.'),
    end_time: z.number().finite().describe('Analysis Out point in seconds from the active sequence start; must be greater than start_time.'),
    timeout_seconds: z.union([z.literal(45), z.literal(60), z.literal(90)]).default(45).describe('Maximum time to wait for Premiere range removal, in seconds. An Extract already running in Premiere may continue after this timeout.'),
  }).strict().refine((range) => range.end_time > range.start_time, {
    message: 'end_time must be greater than start_time',
    path: ['end_time'],
  }),
  run: (ctx, args) => removeRetakes(ctx, args.start_time, args.end_time, args.timeout_seconds),
}];

export function parseWordSrt(raw: string): Cue[] {
  const seconds = (value: string): number => {
    const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value.trim());
    return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000 : NaN;
  };
  return raw.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n\s*\n/).map((block) => {
    const lines = block.split('\n');
    const timeIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeIndex < 0) return null;
    const timeParts = lines[timeIndex]!.split('-->');
    return { start: seconds(timeParts[0] || ''), end: seconds(timeParts[1] || ''), text: lines.slice(timeIndex + 1).join(' ').trim() };
  }).filter((cue): cue is Cue => !!cue && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start && !!cue.text);
}

/** Resolve AI-proposed seconds to exact word-SRT cue boundaries before edits. */
export function matchSrtCueRange(cues: Cue[], startTime: number, endTime: number): { firstIndex: number; lastIndex: number } | null {
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime <= startTime) return null;
  let firstIndex = -1, lastIndex = -1, firstDifference = Infinity, lastDifference = Infinity;
  cues.forEach((cue, index) => {
    const startDifference = Math.abs(cue.start - startTime);
    if (startDifference < firstDifference) { firstIndex = index; firstDifference = startDifference; }
    const endDifference = Math.abs(cue.end - endTime);
    if (endDifference < lastDifference) { lastIndex = index; lastDifference = endDifference; }
  });
  if (firstIndex < 0 || lastIndex < firstIndex || firstDifference > 0.05 || lastDifference > 0.05 || lastIndex - firstIndex + 1 < 3) return null;
  for (let index = firstIndex + 1; index <= lastIndex; index++) {
    if (cues[index]!.start < cues[index - 1]!.end - 0.05) return null;
  }
  return { firstIndex, lastIndex };
}

function normalizeWords(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];
}

function buildTakes(cues: Cue[]): Take[] {
  const takes: Take[] = [];
  let current: Cue[] = [];
  const flush = () => {
    if (!current.length) return;
    const text = current.map((cue) => cue.text).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim();
    const words = normalizeWords(text);
    if (words.length >= 3) {
      const pauses = current.slice(1).filter((cue, index) => cue.start - current[index]!.end > 0.55).length;
      const repeatedWords = words.length - new Set(words).size;
      const terminal = /[.!?…]["')\]]?$/.test(text) ? 0.18 : 0;
      const uniqueRatio = new Set(words).size / words.length;
      const pace = words.length / Math.max(0.25, current[current.length - 1]!.end - current[0]!.start);
      const pacePenalty = pace > 5.5 || pace < 0.65 ? 0.14 : 0;
      const score = Math.min(words.length, 14) / 14 * 0.36 + uniqueRatio * 0.32 + terminal - Math.min(0.25, pauses * 0.06) - Math.min(0.28, repeatedWords * 0.07) - pacePenalty;
      takes.push({ start: current[0]!.start, end: current[current.length - 1]!.end, text, words, score });
    }
    current = [];
  };
  for (const cue of cues) {
    const prior = current[current.length - 1];
    if (prior && (cue.start - prior.end > 1.35 || /[.!?…]["')\]]?$/.test(prior.text))) flush();
    current.push(cue);
  }
  flush();
  return takes;
}

function similarity(left: string[], right: string[]): number {
  if (left.length < 4 || right.length < 4) return left.join(' ') === right.join(' ') ? 1 : 0;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j]!;
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  const edit = 1 - previous[right.length]! / Math.max(left.length, right.length);
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const overlap = [...leftSet].filter((word) => rightSet.has(word)).length / new Set([...leftSet, ...rightSet]).size;
  return Math.max(edit, overlap * 0.92);
}

export function detectRetakeGroups(cues: Cue[]): RetakeGroup[] {
  const takes = buildTakes(cues);
  const parent = takes.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
  for (let i = 0; i < takes.length; i++) for (let j = i + 1; j < takes.length; j++) {
    const left = takes[i]!;
    const right = takes[j]!;
    if (right.start - left.end > 30) break;
    if (right.start < left.end || right.start - left.end < 0.08) continue;
    if (similarity(left.words, right.words) >= 0.68) {
      const a = find(i), b = find(j);
      if (a !== b) parent[b] = a;
    }
  }
  const grouped = new Map<number, Take[]>();
  takes.forEach((take, index) => {
    const root = find(index);
    const group = grouped.get(root) || [];
    group.push(take);
    grouped.set(root, group);
  });
  let id = 0;
  return [...grouped.values()].filter((group) => group.length > 1).map((group) => {
    const sorted = [...group].sort((a, b) => b.score - a.score);
    const best = sorted[0]!;
    const margin = best.score - sorted[1]!.score;
    return { id: ++id, takes: group.sort((a, b) => a.start - b.start), best: margin >= 0.09 ? best : null };
  });
}

async function removeRetakes(ctx: ToolContext, startTime: number, endTime: number, timeoutSeconds = 45): Promise<Record<string, unknown>> {
  if (removeRetakesInFlight) return { success: false, status: 'busy', error: 'A remove_retakes operation is already running.' };
  removeRetakesInFlight = true;
  const workflowStartedAt = Date.now();
  let srtGenerationMs = 0, apiAnalysisMs = 0, removeRangeMs = 0;
  try {
    if (ctx.signal?.aborted) return { success: false, status: 'cancelled', error: 'Stopped before local transcription started; no timeline changes were made.' };
    ctx.logger.info(`[remove_retakes] stage=srt_start in=${startTime}s out=${endTime}s`);
    const srtStartedAt = Date.now();
    const generated = await generateSrtForRange(ctx, startTime, endTime);
    if (ctx.signal?.aborted) return { success: false, status: 'cancelled', error: 'Stop requested during local SRT generation. The current local Premiere/Whisper task may finish in the background; no retake cuts were started.' };
    srtGenerationMs = Date.now() - srtStartedAt;
    ctx.logger.info(`[remove_retakes] stage=srt_complete durationMs=${srtGenerationMs}`);
    const transcript = (generated.result && typeof generated.result === 'object' ? generated.result : generated) as Record<string, unknown>;
    if (generated.success === false || transcript.success !== true || transcript.srtGenerated !== true || typeof transcript.srtPath !== 'string') {
      return { success: false, status: 'srt_unavailable', error: String(transcript.error || generated.error || 'Local transcription did not produce an SRT file.'), srt: transcript };
    }
    const srtPath = resolve(transcript.srtPath);
    const expectedRoot = resolve(tmpdir(), 'premiere-mcp-local-srt') + sep;
    if (!srtPath.startsWith(expectedRoot)) return { success: false, status: 'srt_path_rejected', error: 'The generated SRT path is outside the Local SRT temporary directory.' };
    const cues = parseWordSrt(await readFile(srtPath, 'utf8'));
    if (cues.length < 6 || cues.some((cue) => normalizeWords(cue.text).length > 3)) {
      return { success: false, status: 'word_level_srt_required', activeSequence: transcript.activeSequence, srtPath, error: 'A usable word-level SRT was not generated; no timeline changes were made.' };
    }

    let confidenceWords: Array<{ start: number; end: number; probability: number }> = [];
    if (typeof transcript.whisperMetadataPath === 'string') {
      const metadataPath = resolve(transcript.whisperMetadataPath);
      if (metadataPath.startsWith(expectedRoot)) {
        try {
          const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { words?: Array<{ start?: number; end?: number; probability?: number }> };
          confidenceWords = (metadata.words || []).filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && Number.isFinite(word.probability))
            .map((word) => ({ start: Number(word.start), end: Number(word.end), probability: Number(word.probability) }));
        } catch (error) {
          ctx.logger.error(`[remove_retakes] stage=whisper_metadata_unavailable ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (!ctx.analyzeRetakes) return { success: false, status: 'analysis_unavailable', groupsDetected: 0, error: 'No saved API/local model is configured for retake analysis; no timeline changes were made.' };
    const analysisCues = cues.map((cue, index) => {
      const matches = confidenceWords.filter((word) => word.start >= cue.start - 0.04 && word.end <= cue.end + 0.04);
      return {
        index,
        start: cue.start,
        end: cue.end,
        text: cue.text,
        ...(matches.length ? { whisperConfidence: matches.reduce((sum, word) => sum + word.probability, 0) / matches.length } : {}),
      };
    });
    let analyzed: Array<{ id: number; takes: Array<{ start_time: number; end_time: number }>; bestTakeIndex: number | null; confidence: number; reason: string }>;
    try {
      ctx.logger.info(`[remove_retakes] stage=api_analysis_start cues=${analysisCues.length}`);
      const analysisStartedAt = Date.now();
      analyzed = await ctx.analyzeRetakes(analysisCues, ctx.signal);
      apiAnalysisMs = Date.now() - analysisStartedAt;
      ctx.logger.info(`[remove_retakes] stage=api_analysis_complete cues=${analysisCues.length} groups=${analyzed.length}`);
    } catch (error) {
      if (ctx.signal?.aborted) return { success: false, status: 'cancelled', groupsDetected: 0, error: 'Retake analysis stopped by the user. No timeline changes were made.' };
      return { success: false, status: 'analysis_failed', groupsDetected: 0, error: `${error instanceof Error ? error.message : String(error)} No timeline changes were made.` };
    }
    const seenIds = new Set<number>();
    const occupiedCueIndexes = new Set<number>();
    const groups: RetakeGroup[] = analyzed.map((candidate) => {
      if (!Number.isInteger(candidate.id) || candidate.id < 1 || seenIds.has(candidate.id) || !Array.isArray(candidate.takes) || candidate.takes.length < 2) {
        throw new Error('The configured model returned an invalid retake group. No timeline changes were made.');
      }
      seenIds.add(candidate.id);
      const takes: Take[] = candidate.takes.map((span) => {
        const start = Number(span.start_time), end = Number(span.end_time);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
          throw new Error('The configured model returned a retake range outside the SRT. No timeline changes were made.');
        }
        const matchedRange = matchSrtCueRange(analysisCues, start, end);
        if (!matchedRange) {
          throw new Error(`The configured model returned ${start.toFixed(3)}–${end.toFixed(3)}s, which does not match SRT cue boundaries. No timeline changes were made.`);
        }
        const first = matchedRange.firstIndex, last = matchedRange.lastIndex;
        const selectedCues = analysisCues.slice(first, last + 1);
        for (let index = first; index <= last; index++) {
          if (occupiedCueIndexes.has(index)) throw new Error('The configured model returned overlapping retake groups. No timeline changes were made.');
          occupiedCueIndexes.add(index);
        }
        const text = selectedCues.map((cue) => cue.text).join(' ').trim();
        const words = normalizeWords(text);
        const confidences = selectedCues.map((cue) => cue.whisperConfidence).filter((value): value is number => value !== undefined);
        const uniqueRatio = words.length ? new Set(words).size / words.length : 0;
        const pace = words.length / Math.max(0.25, selectedCues[selectedCues.length - 1]!.end - selectedCues[0]!.start);
        const score = Math.min(words.length, 14) / 14 * 0.36 + uniqueRatio * 0.32 - (pace > 5.5 || pace < 0.65 ? 0.14 : 0);
        return { start: selectedCues[0]!.start, end: selectedCues[selectedCues.length - 1]!.end, text, words, score, ...(confidences.length ? { whisperConfidence: confidences.reduce((sum, value) => sum + value, 0) / confidences.length } : {}) };
      });
      if (takes.some((take, index) => index > 0 && take.start < takes[index - 1]!.start)) {
        throw new Error('The configured model returned attempts out of timeline order. No timeline changes were made.');
      }
      if (takes.some((take, index) => index > 0 && take.start < takes[index - 1]!.end - 0.05)) {
        throw new Error('The configured model returned overlapping attempts in a retake group. No timeline changes were made.');
      }
      const originalBest = candidate.bestTakeIndex;
      const best = originalBest !== null && Number.isInteger(originalBest) && originalBest >= 0 && originalBest < takes.length
        ? takes[originalBest] || null : null;
      return { id: candidate.id, takes, best: Number.isFinite(candidate.confidence) && candidate.confidence >= 0.75 ? best : null };
    });
    if (ctx.signal?.aborted) return { success: false, status: 'cancelled', error: 'Retake analysis was stopped; no timeline changes were made.' };
    const sequenceId = String(transcript.activeSequenceId || '');
    const savedPlan = await saveRetakePlan(srtPath, transcript.activeSequence, sequenceId, { start_time: startTime, end_time: endTime }, groups);
    if (!groups.length) {
      return { success: true, status: 'no_retakes_found', activeSequence: transcript.activeSequence, srtPath, planPath: savedPlan.planPath, range: { start_time: startTime, end_time: endTime }, groupsDetected: 0, groupsProcessed: 0, rejectedTakesRemoved: 0, groupsSkippedUncertain: 0, analyzedWordCues: analysisCues.length, audioAnalysisUsed: confidenceWords.length > 0, whisperConfidenceUsed: confidenceWords.length > 0, note: `The configured API model analyzed ${analysisCues.length} timed word cues and returned no retake groups. No timeline edits were made.` };
    }
    const skipped = groups.filter((group) => !group.best);
    const confident = groups.filter((group) => group.best);
    if (!confident.length) {
      return { success: true, status: groups.length ? 'ambiguous_groups_skipped' : 'no_retakes_found', activeSequence: transcript.activeSequence, srtPath, planPath: savedPlan.planPath, range: { start_time: startTime, end_time: endTime }, groupsDetected: groups.length, groupsProcessed: 0, rejectedTakesRemoved: 0, groupsSkippedUncertain: skipped.length, audioAnalysisUsed: confidenceWords.length > 0, whisperConfidenceUsed: confidenceWords.length > 0, note: 'No candidate reached the model confidence threshold, so no takes were removed.' };
    }

    const requests: RemoveRequest[] = savedPlan.removeRangeCalls;
    ctx.logger.info(`[remove_retakes] stage=analysis groups=${groups.length} confident=${confident.length} skipped=${skipped.length} cuts=${requests.length}`);
    if (!sequenceId) return { success: false, status: 'sequence_identity_unavailable', planPath: savedPlan.planPath, error: 'The SRT generator did not return an active sequence ID; no timeline edits were made.' };
    const ranges = requests.map(({ start_time, end_time }) => ({ start_time, end_time }));
    const cutStartedAt = Date.now();
    if (ctx.signal?.aborted) return { success: false, status: 'cancelled', groupsDetected: groups.length, groupsSkippedUncertain: skipped.length, error: 'Stopped before Premiere received the cut command; no retake cuts were started.' };
    const cutResults = requests.length ? await removeRangesDetailedForWorkflow(ctx, ranges, sequenceId, timeoutSeconds * 1000) : [];
    removeRangeMs = Date.now() - cutStartedAt;
    const removals = cutResults.map((item) => item?.success === true ? 1 : 0);
    const removed = requests.filter((_, index) => removals[index] === 1).map((request, index) => {
      const operation = cutResults.filter((item) => item?.success === true)[index];
      return { ...request, actualStart: Number(operation?.actualStartTime), actualEnd: Number(operation?.actualEndTime) };
    });
    const groupFailedCuts = new Set<number>();
    const failedCuts = requests.filter((cut, index) => {
      const failed = removals[index] !== 1;
      if (failed && cut.groupId !== undefined) groupFailedCuts.add(cut.groupId);
      return failed;
    });
    const cutErrors = requests.flatMap((cut, index) => {
      if (removals[index] === 1) return [];
      const operation = cutResults[index];
      const detail = [operation?.status, operation?.error].filter((value) => typeof value === 'string' && value).join(': ');
      return [`remove_range failed for ${cut.start_time.toFixed(3)}–${cut.end_time.toFixed(3)}s${detail ? ` (${detail})` : ''}`];
    });
    const groupsProcessed = confident.filter((group) => !groupFailedCuts.has(group.id)).length;
    return {
      success: failedCuts.length === 0,
      status: failedCuts.length ? 'partial' : 'completed',
      activeSequence: transcript.activeSequence,
      srtPath,
      planPath: savedPlan.planPath,
      range: { start_time: startTime, end_time: endTime },
      groupsDetected: groups.length,
      groupsProcessed,
      rejectedTakesRemoved: removed.length,
      groupsSkippedUncertain: skipped.length,
      audioAnalysisUsed: confidenceWords.length > 0,
      whisperConfidenceUsed: confidenceWords.length > 0,
      removalResults: removals,
      errors: cutErrors,
      timingMs: { srtGeneration: srtGenerationMs, apiAnalysis: apiAnalysisMs, removeRange: removeRangeMs, total: Date.now() - workflowStartedAt },
      note: confidenceWords.length
        ? 'Best-take selection used the configured assistant model, word timing, transcript completeness, pauses, and Whisper word-confidence as an uncalibrated audio-derived hint. Speech delivery was not independently scored.'
        : 'Best-take selection used the configured assistant model, word timing, and transcript completeness. Whisper confidence metadata was unavailable; speech delivery was not independently scored.',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error(`[remove_retakes] stage=failed ${message}`);
    return { success: false, status: 'failed', error: message };
  } finally {
    removeRetakesInFlight = false;
  }
}
