import { z } from 'zod';
import type { ToolContext, ToolModule } from '../context.js';

let removeRangeInFlight = false;
// Bound the caller's wait for both a single cut and retake batches to 45s.
// This only limits how long MCP waits; a native Extract already running inside
// Premiere cannot be safely interrupted and may still finish after the timeout.
const REMOVE_RANGE_TIMEOUT_MS = 45000;
const DEFAULT_RETAKE_REMOVE_TIMEOUT_MS = 45000;

type RangeRequest = { start_time: number; end_time: number };

export const rangeTools: ToolModule[] = [
  {
    name: 'remove_range',
    description: 'Immediately send the requested range to the active Premiere sequence for native ripple Extract. Times are seconds from sequence start. Returns 1 or 0. For multiple requested ranges, call remove_ranges once. After this tool returns, end the turn with no confirmation sentence: do not inspect the timeline, verify the bridge, retry, or call another tool based on the return value. Never repeat an identical range call in the same user request.',
    inputSchema: z.object({
      start_time: z.number().finite().min(0).describe('Range start in seconds from the start of the active sequence.'),
      end_time: z.number().finite().describe('Range end in seconds from the start of the active sequence; must be greater than start_time.'),
    }).strict().refine((range) => range.end_time > range.start_time, {
      message: 'end_time must be greater than start_time',
      path: ['end_time'],
    }),
    run: (ctx, args) => removeRange(ctx, args.start_time, args.end_time),
  },
  {
    name: 'remove_ranges',
    description: 'Send several ranges to the active Premiere sequence in one bridge call. Provide all requested ranges together. They are processed from the latest time to the earliest so earlier timecodes stay valid after later material is removed. Returns a compact status array. After this tool returns, end the turn with no confirmation sentence: do not inspect the timeline, verify the bridge, retry, or call another tool based on the return value. Never repeat an identical range call in the same user request.',
    inputSchema: z.object({
      ranges: z.array(z.object({
        start_time: z.number().finite().min(0),
        end_time: z.number().finite(),
      }).strict().refine((range) => range.end_time > range.start_time, {
        message: 'end_time must be greater than start_time',
        path: ['end_time'],
      })).min(1).max(20),
    }).strict(),
    run: (ctx, args) => removeRanges(ctx, args.ranges),
  },
];

async function removeRange(ctx: ToolContext, startTime: number, endTime: number): Promise<number> {
  if (removeRangeInFlight) {
    return 0;
  }

  removeRangeInFlight = true;
  try {
    const script = `(function () { if (typeof MCP_removeRange !== 'function') return JSON.stringify({ success: false, status: 'host_function_unavailable', error: 'The shared remove_range host function is not loaded. Restart Premiere Pro and reopen MCP Bridge (CEP).' }); if (MCP_removeRangeImplementation !== 'native-extract-seconds-receipt-v3') return JSON.stringify({ success: false, status: 'host_function_outdated', error: 'The loaded Premiere range function is outdated. Restart Premiere Pro so it loads the current remove-range-host.jsx.' }); return MCP_removeRange(${JSON.stringify(startTime)}, ${JSON.stringify(endTime)}, 'single'); })()`;
    ctx.logger.info(`[remove_range] stage=bridge_request start=${startTime}s end=${endTime}s`);
    let result = await ctx.bridge.executeScript(script, REMOVE_RANGE_TIMEOUT_MS, false, 0, { nativeResultReceipt: true, signal: ctx.signal }) as any;
    for (let depth = 0; depth < 4; depth++) {
      if (typeof result === 'string') {
        try { result = JSON.parse(result); continue; } catch { break; }
      }
      if (result && !Array.isArray(result) && typeof result === 'object' && 'result' in result) {
        if (result.success === false) {
          ctx.logger.error(`[remove_range] stage=bridge_failure ${String(result.error || 'CEP bridge rejected the command.')}`);
          return 0;
        }
        result = result.result;
        continue;
      }
      break;
    }
    if (!result || typeof result !== 'object') {
      ctx.logger.error(`[remove_range] stage=bridge_response invalid=${JSON.stringify(result ?? null)}`);
      return 0;
    }
    ctx.logger.info(`[remove_range] stage=premiere_result ${JSON.stringify(result)}`);
    const resultError = typeof result.error === 'string' ? result.error : '';
    if (result.success === false && /timed out|did not return a result/i.test(resultError)) {
      return 0;
    }
    return result.success === true ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error(`[remove_range] stage=bridge_failure ${message}`);
    return 0;
  } finally {
    removeRangeInFlight = false;
  }
}

export async function removeRangesForWorkflow(ctx: ToolContext, ranges: RangeRequest[]): Promise<number[]> {
  return removeRanges(ctx, ranges);
}

export async function removeRangesDetailedForWorkflow(ctx: ToolContext, ranges: RangeRequest[], expectedSequenceId?: string, timeoutMs = DEFAULT_RETAKE_REMOVE_TIMEOUT_MS): Promise<Array<Record<string, unknown> | null>> {
  const failure = (error: string, status = 'bridge_failure') => ranges.map(() => ({ success: false, status, error }));
  if (removeRangeInFlight) return failure('Another remove_range operation is already running.', 'busy');
  removeRangeInFlight = true;
  try {
    const ordered = ranges.map((range, index) => ({ ...range, index }))
      .sort((a, b) => b.start_time - a.start_time || b.end_time - a.end_time);
    const initial = JSON.stringify(ranges.map(() => null));
    const script = `(function(){var expected=${JSON.stringify(expectedSequenceId || '')};var requests=${JSON.stringify(ordered)};var output=${initial};function failed(status,message){for(var j=0;j<requests.length;j++)output[requests[j].index]={success:false,status:status,error:message};return JSON.stringify(output);}if(expected&&(!app.project||!app.project.activeSequence||String(app.project.activeSequence.sequenceID)!==expected))return failed('sequence_mismatch','The active sequence changed before remove_range started.');if(typeof MCP_removeRange!=='function')return failed('host_function_unavailable','The shared Premiere remove_range function is not loaded. Restart Premiere Pro and reopen MCP Bridge (CEP).');if(MCP_removeRangeImplementation!=='native-extract-seconds-receipt-v3')return failed('host_function_outdated','The loaded Premiere range function is outdated. Restart Premiere Pro so it loads the current remove-range-host.jsx.');for(var i=0;i<requests.length;i++){var item=requests[i];var parsed=null;try{parsed=JSON.parse(MCP_removeRange(item.start_time,item.end_time,'batch',output,item.index,i===requests.length-1));}catch(e){parsed={success:false,status:'invalid_host_response',error:String(e)};}if(!parsed||parsed.success!==true||parsed.duplicateSuppressed){output[item.index]=parsed||{success:false,status:'invalid_host_response',error:'Premiere returned no result.'};for(var k=i+1;k<requests.length;k++)output[requests[k].index]={success:false,status:'not_executed',error:'An earlier remove_range operation failed.'};break;}output[item.index]=parsed;}return JSON.stringify(output);})()`;
    ctx.logger.info(`[remove_retakes] stage=remove_range_batch count=${ranges.length} order=${ordered.map((range) => `${range.start_time}-${range.end_time}`).join(',')}`);
    const startedAt = Date.now();
    let result = await ctx.bridge.executeScript(script, timeoutMs, false, 0, { nativeResultReceipt: true, signal: ctx.signal }) as any;
    // CEP wraps ExtendScript output as {success:true,result:"[...]"}; unwrap
    // that transport envelope before interpreting the operation result array.
    for (let depth = 0; depth < 4; depth++) {
      if (typeof result === 'string') {
        try { result = JSON.parse(result); continue; } catch { break; }
      }
      if (result && !Array.isArray(result) && typeof result === 'object' && 'result' in result) {
        if (result.success === false) return failure(String(result.error || 'The CEP bridge rejected the remove_range batch.'), 'bridge_failure');
        result = result.result;
        continue;
      }
      break;
    }
    ctx.logger.info(`[remove_retakes] stage=remove_range_batch_response durationMs=${Date.now() - startedAt}`);
    if (result && !Array.isArray(result) && typeof result === 'object' && result.success === false) {
      return failure(String(result.error || 'The CEP bridge rejected the remove_range batch.'), String(result.status || 'bridge_failure'));
    }
    if (Array.isArray(result) && result.length === ranges.length) return result as Array<Record<string, unknown> | null>;
    ctx.logger.error(`[remove_retakes] stage=remove_range_batch_invalid result=${JSON.stringify(result ?? null)}`);
    return failure('Premiere returned an unexpected remove_range batch response.', 'invalid_response');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = ctx.signal?.aborted === true;
    const detail = cancelled
      ? 'Stop requested while waiting for Premiere. An accepted native Extract may still complete; inspect the sequence before retrying.'
      : message;
    ctx.logger.error(`[remove_retakes] stage=${cancelled ? 'remove_range_batch_wait_stopped' : 'remove_range_batch_failed'} ${detail}`);
    return failure(detail, cancelled ? 'cancelled_waiting' : 'bridge_failure');
  } finally {
    removeRangeInFlight = false;
  }
}

async function removeRanges(ctx: ToolContext, ranges: RangeRequest[]): Promise<number[]> {
  if (removeRangeInFlight) return ranges.map(() => 0);
  removeRangeInFlight = true;
  try {
    // Process descending by time. Removing a later interval cannot shift the
    // original timecodes of ranges earlier in the sequence.
    const ordered = ranges
      .map((range, index) => ({ ...range, index }))
      .sort((a, b) => b.start_time - a.start_time || b.end_time - a.end_time);
    const zeroResult = JSON.stringify(ranges.map(() => 0));
    const script = `(function(){if(typeof MCP_removeRange!=='function')return ${JSON.stringify(zeroResult)};var requests=${JSON.stringify(ordered)};var output=${JSON.stringify(ranges.map(() => 0))};for(var i=0;i<requests.length;i++){var item=requests[i];var raw=MCP_removeRange(item.start_time,item.end_time);var parsed=null;try{parsed=JSON.parse(raw);}catch(e){}if(parsed&&parsed.success===true){output[item.index]=1;}else{break;}}return JSON.stringify(output);})()`;
    ctx.logger.info(`[remove_range] stage=batch_bridge_request count=${ranges.length} order=${ordered.map((range) => `${range.start_time}-${range.end_time}`).join(',')}`);
    const result = await ctx.bridge.executeScript(script, 45000);
    if (Array.isArray(result) && result.length === ranges.length && result.every((value) => value === 0 || value === 1)) {
      ctx.logger.info(`[remove_range] stage=batch_premiere_result results=${JSON.stringify(result)}`);
      return result as number[];
    }
    ctx.logger.error(`[remove_range] stage=batch_invalid_response result=${JSON.stringify(result ?? null)}`);
    return ranges.map(() => 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error(`[remove_range] stage=batch_bridge_failure ${message}`);
    return ranges.map(() => 0);
  } finally {
    removeRangeInFlight = false;
  }
}
