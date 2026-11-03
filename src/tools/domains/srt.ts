/** Trigger the CEP panel's existing local SRT workflow through the file bridge. */
import { z } from 'zod';
import type { ToolContext, ToolModule } from '../context.js';

export const LOCAL_SRT_COMMAND_MARKER = '__MCP_LOCAL_SRT_GENERATE__';
const LOCAL_SRT_COMMAND = `(function(){return ${JSON.stringify(LOCAL_SRT_COMMAND_MARKER)};})()`;
const LOCAL_SRT_TIMEOUT_MS = 60 * 60 * 1000;

let generationInFlight = false;

export const srtTools: ToolModule[] = [
  {
    name: 'generate_srt',
    description: 'Runs the Local SRT generator already configured in the open Premiere MCP Bridge (CEP) panel. Uses the active sequence and the panel’s saved defaults, transcribes locally, saves an SRT, and imports subtitles onto the sequence. Takes no arguments; the Premiere panel must be open and the bridge started.',
    inputSchema: z.object({}).strict(),
    run: async (ctx: ToolContext) => generateSrt(ctx),
  },
];

async function generateSrt(ctx: ToolContext): Promise<Record<string, unknown>> {
  if (generationInFlight) {
    return {
      success: false,
      status: 'busy',
      activeSequenceFound: false,
      transcriptionStarted: false,
      srtGenerated: false,
      subtitlesImported: false,
      error: 'SRT generation is already in progress. Wait for the current request to finish.',
    };
  }

  generationInFlight = true;
  try {
    const result = await ctx.bridge.executeScript(LOCAL_SRT_COMMAND, LOCAL_SRT_TIMEOUT_MS);
    if (result === LOCAL_SRT_COMMAND_MARKER) {
      return {
        success: false,
        status: 'cep_outdated',
        activeSequenceFound: false,
        transcriptionStarted: false,
        srtGenerated: false,
        subtitlesImported: false,
        error: 'The MCP Bridge CEP extension does not include the SRT command handler yet. Rebuild/install the extension, then restart Premiere and reopen MCP Bridge (CEP).',
      };
    }
    if (!result || typeof result !== 'object') {
      return {
        success: false,
        status: 'invalid_response',
        activeSequenceFound: false,
        transcriptionStarted: false,
        srtGenerated: false,
        subtitlesImported: false,
        error: 'The Premiere CEP extension returned no SRT workflow result.',
        response: result ?? null,
      };
    }
    return result as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const panelNotOpen = /MCP Bridge is not running|Bridge panel is not running/i.test(message);
    const bridgeNotStarted = /panel is open but the bridge is not started/i.test(message);
    return {
      success: false,
      status: panelNotOpen ? 'panel_not_open' : bridgeNotStarted ? 'bridge_not_started' : 'bridge_error',
      activeSequenceFound: false,
      transcriptionStarted: false,
      srtGenerated: false,
      subtitlesImported: false,
      error: panelNotOpen
        ? 'Open Premiere Pro, then open Window > Extensions > MCP Bridge (CEP) and start the bridge before calling generate_srt.'
        : bridgeNotStarted
          ? 'MCP Bridge (CEP) is open but stopped. Click Start Bridge in the panel, then call generate_srt again.'
          : `Could not complete the Local SRT request through the Premiere bridge: ${message}`,
    };
  } finally {
    generationInFlight = false;
  }
}

/** Generate a word-level SRT for a bounded range without importing it again. */
export async function generateSrtForRange(ctx: ToolContext, startTime: number, endTime: number): Promise<Record<string, unknown>> {
  if (generationInFlight) {
    return { success: false, status: 'busy', error: 'SRT generation is already in progress.' };
  }
  generationInFlight = true;
  try {
    const command = `__MCP_LOCAL_SRT_RETAKES__${encodeURIComponent(JSON.stringify({ start_time: startTime, end_time: endTime }))}`;
    const result = await ctx.bridge.executeScript(`(function(){return ${JSON.stringify(command)};})()`, LOCAL_SRT_TIMEOUT_MS, false, 0, { signal: ctx.signal });
    if (!result || typeof result !== 'object') {
      return { success: false, status: 'invalid_response', error: 'The Premiere CEP extension returned no bounded SRT result.' };
    }
    return result as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error(`[remove_retakes] stage=srt_generation_failed ${message}`);
    return { success: false, status: 'srt_generation_failed', error: message };
  } finally {
    generationInFlight = false;
  }
}
