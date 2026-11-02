import { srtTools, LOCAL_SRT_COMMAND_MARKER } from '../../tools/domains/srt.js';

describe('generate_srt MCP tool', () => {
  const tool = srtTools[0];

  it('is directly callable and accepts no parameters', () => {
    expect(tool.name).toBe('generate_srt');
    expect(tool.inputSchema.parse({})).toEqual({});
    expect(() => tool.inputSchema.parse({ model: 'small' })).toThrow();
  });

  it('triggers the CEP Local SRT workflow and returns its completed result', async () => {
    const payload = {
      success: true,
      status: 'completed',
      activeSequenceFound: true,
      activeSequence: 'Test sequence',
      transcriptionStarted: true,
      srtGenerated: true,
      subtitlesImported: true,
      srtPath: 'C:\\temp\\captions.srt',
    };
    const executeScript = jest.fn().mockResolvedValue(payload);
    const result = await tool.run({ bridge: { executeScript } } as never, {});

    expect(executeScript).toHaveBeenCalledWith(
      expect.stringContaining(LOCAL_SRT_COMMAND_MARKER),
      60 * 60 * 1000,
    );
    expect(result).toEqual(payload);
  });

  it('explains that the CEP panel must be open when the bridge is unavailable', async () => {
    const executeScript = jest.fn().mockRejectedValue(new Error('MCP Bridge is not running'));
    const result = await tool.run({ bridge: { executeScript } } as never, {});

    expect(result).toMatchObject({
      success: false,
      status: 'panel_not_open',
      activeSequenceFound: false,
      transcriptionStarted: false,
      srtGenerated: false,
      subtitlesImported: false,
    });
    expect((result as { error: string }).error).toMatch(/Window > Extensions > MCP Bridge/);
  });

  it('rejects a concurrent generation request', async () => {
    let finish: ((value: unknown) => void) | undefined;
    const executeScript = jest.fn(() => new Promise((resolve) => { finish = resolve; }));
    const context = { bridge: { executeScript } } as never;
    const first = tool.run(context, {});
    const second = await tool.run(context, {});

    expect(second).toMatchObject({ success: false, status: 'busy' });
    finish?.({ success: true, status: 'completed' });
    await first;
  });
});
