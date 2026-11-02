import { z } from 'zod';
import type { ToolContext, ToolModule } from '../context.js';

let removeRangeInFlight = false;

export const rangeTools: ToolModule[] = [
  {
    name: 'remove_range',
    description: 'Once the Premiere connection is established, call this immediately once when the user gives a cut range; do not inspect the project or call other editing tools first. Uses Premiere Pro native Extract on the active sequence In/Out range to ripple the selected interval across sync-locked audio/video tracks. Times are seconds from the sequence start. After success, return one brief confirmation and stop if this was the only task; otherwise continue the next requested task. Do not add post-cut analysis or retry automatically.',
    inputSchema: z.object({
      start_time: z.number().finite().min(0).describe('Range start in seconds from the start of the active sequence.'),
      end_time: z.number().finite().describe('Range end in seconds from the start of the active sequence; must be greater than start_time.'),
    }).strict().refine((range) => range.end_time > range.start_time, {
      message: 'end_time must be greater than start_time',
      path: ['end_time'],
    }),
    run: (ctx, args) => removeRange(ctx, args.start_time, args.end_time),
  },
];

async function removeRange(ctx: ToolContext, startTime: number, endTime: number): Promise<Record<string, unknown>> {
  if (removeRangeInFlight) {
    return { success: false, status: 'busy', error: 'Another remove_range operation is already running.' };
  }

  removeRangeInFlight = true;
  try {
    const script = `(function () { if (typeof MCP_removeRange !== 'function') return JSON.stringify({ success: false, status: 'host_function_unavailable', error: 'The shared remove_range host function is not loaded. Close and reopen MCP Bridge (CEP), then retry.' }); return MCP_removeRange(${JSON.stringify(startTime)}, ${JSON.stringify(endTime)}); })()`;
    ctx.logger.info(`[remove_range] stage=bridge_request start=${startTime}s end=${endTime}s`);
    // Keep the native Premiere call bounded to the CEP bridge's 45s watchdog.
    // Waiting five minutes after Premiere stops responding leaves the AI client
    // appearing to think while no useful result can arrive.
    const result = await ctx.bridge.executeScript(script, 45000);
    if (!result || typeof result !== 'object') {
      ctx.logger.error(`[remove_range] stage=bridge_response invalid=${JSON.stringify(result ?? null)}`);
      return { success: false, status: 'invalid_response', error: 'Premiere returned no remove_range operation result.', response: result ?? null };
    }
    ctx.logger.info(`[remove_range] stage=premiere_result ${JSON.stringify(result)}`);
    const resultError = typeof result.error === 'string' ? result.error : '';
    if (result.success === false && /timed out|did not return a result/i.test(resultError)) {
      return {
        ...result,
        status: 'premiere_timeout',
        retrySafe: false,
        timelineMayBeModified: true,
        error: `${resultError} The command reached Premiere, so inspect the sequence before retrying.`,
      };
    }
    return result as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error(`[remove_range] stage=bridge_failure ${message}`);
    return { success: false, status: 'bridge_error', error: `Could not complete remove_range through the Premiere bridge: ${message}` };
  } finally {
    removeRangeInFlight = false;
  }
}
