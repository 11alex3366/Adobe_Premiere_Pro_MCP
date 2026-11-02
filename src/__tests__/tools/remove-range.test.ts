import { rangeTools } from '../../tools/domains/range.js';
import { PremiereProTools } from '../../tools/index.js';

describe('remove_range MCP tool', () => {
  const tool = rangeTools[0];

  it('requires exactly numeric start_time and end_time values', () => {
    expect(tool.name).toBe('remove_range');
    expect(tool.inputSchema.parse({ start_time: 5, end_time: 7 })).toEqual({ start_time: 5, end_time: 7 });
    for (const args of [
      {},
      { start_time: '5', end_time: 7 },
      { start_time: -1, end_time: 7 },
      { start_time: 7, end_time: 7 },
      { start_time: 8, end_time: 7 },
      { start_time: 5, end_time: 7, sequence_id: 'other' },
    ]) expect(() => tool.inputSchema.parse(args)).toThrow();
  });

  it('describes the native Extract ripple operation', () => {
    expect(tool.description).toContain('native Extract');
    expect(tool.description).toContain('sync-locked');
  });

  it('calls the shared Premiere-side implementation and returns its verification result', async () => {
    const payload = {
      success: true,
      status: 'completed',
      activeSequenceFound: true,
      sequenceName: 'Disposable test sequence',
      actualStartTime: 5,
      actualEndTime: 7,
      removedDurationSeconds: 2,
      operation: 'Extract (ripple delete across all audio/video tracks)',
      verified: true,
      tracksVerified: 4,
    };
    const executeScript = jest.fn().mockResolvedValue(payload);
    const result = await tool.run({ bridge: { executeScript }, logger: { info: jest.fn(), error: jest.fn() } } as never, { start_time: 5, end_time: 7 });

    expect(executeScript).toHaveBeenCalledWith(expect.stringContaining('MCP_removeRange(5, 7)'), 45000);
    const script = executeScript.mock.calls[0][0] as string;
    expect(result).toEqual(payload);
  });

  it('normalizes MCP snake_case and camelCase aliases before strict schema validation', async () => {
    const executeScript = jest.fn().mockResolvedValue({ success: true, status: 'completed' });
    const tools = new PremiereProTools({ executeScript } as never);

    expect(await tools.executeTool('remove_range', { start_time: 5, end_time: 7 })).toMatchObject({ success: true });
    expect(await tools.executeTool('remove_range', { startTime: 8, endTime: 10 })).toMatchObject({ success: true });
    expect(executeScript).toHaveBeenNthCalledWith(1, expect.stringContaining('MCP_removeRange(5, 7)'), 45000);
    expect(executeScript).toHaveBeenNthCalledWith(2, expect.stringContaining('MCP_removeRange(8, 10)'), 45000);
  });

  it('routes the catalog invoke_tool wrapper to the same direct handler', async () => {
    const executeScript = jest.fn().mockResolvedValue({ success: true, status: 'completed' });
    const tools = new PremiereProTools({ executeScript } as never);
    const result = await tools.executeTool('invoke_tool', {
      name: 'remove_range',
      arguments: { start_time: 5, end_time: 7 },
    });
    expect(result).toMatchObject({ success: true, status: 'completed' });
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith(expect.stringContaining('MCP_removeRange(5, 7)'), 45000);
  });

  it('rejects a concurrent remove_range request', async () => {
    let finish: ((value: unknown) => void) | undefined;
    const executeScript = jest.fn(() => new Promise((resolve) => { finish = resolve; }));
    const context = { bridge: { executeScript }, logger: { info: jest.fn(), error: jest.fn() } } as never;
    const first = tool.run(context, { start_time: 5, end_time: 7 });
    const second = await tool.run(context, { start_time: 10, end_time: 12 });

    expect(second).toMatchObject({ success: false, status: 'busy' });
    finish?.({ success: true, status: 'completed' });
    await first;
  });

  it('returns a clear bridge error without claiming an edit occurred', async () => {
    const executeScript = jest.fn().mockRejectedValue(new Error('MCP Bridge is not running'));
    const result = await tool.run({ bridge: { executeScript }, logger: { info: jest.fn(), error: jest.fn() } } as never, { start_time: 5, end_time: 7 });
    expect(result).toMatchObject({ success: false, status: 'bridge_error' });
    expect((result as { error: string }).error).toMatch(/MCP Bridge is not running/);
  });

  it('marks a Premiere timeout as an unknown outcome', async () => {
    const executeScript = jest.fn().mockResolvedValue({
      success: false,
      error: 'ExtendScript execution timed out after 45000ms. Premiere Pro or the CEP scripting host did not return a result.',
    });
    const context = { bridge: { executeScript }, logger: { info: jest.fn(), error: jest.fn() } } as never;
    const result = await tool.run(context, { start_time: 10, end_time: 15 });

    expect(result).toMatchObject({
      success: false,
      status: 'premiere_timeout',
      retrySafe: false,
      timelineMayBeModified: true,
    });
    expect(executeScript).toHaveBeenCalledTimes(1);
  });
});
