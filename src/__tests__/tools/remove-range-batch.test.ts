import { removeRangesDetailedForWorkflow } from '../../tools/domains/range.js';

describe('remove_ranges bridge response handling for remove_retakes', () => {
  const ranges = [{ start_time: 12.54, end_time: 16.34 }];

  it('unwraps the CEP success envelope and returns Premiere operation results', async () => {
    const premiereResult = [{ success: false, status: 'native_extract_unverified', error: 'duration did not change' }];
    const ctx = {
      bridge: { executeScript: jest.fn().mockResolvedValue({ success: true, result: JSON.stringify(premiereResult) }) },
      logger: { info: jest.fn(), error: jest.fn() },
    } as any;

    await expect(removeRangesDetailedForWorkflow(ctx, ranges, 'sequence-1')).resolves.toEqual(premiereResult);
    expect(ctx.bridge.executeScript).toHaveBeenCalledWith(expect.any(String), 300000, false, 10000);
  });

  it('returns the CEP bridge error instead of replacing it with null results', async () => {
    const ctx = {
      bridge: { executeScript: jest.fn().mockResolvedValue({ success: false, error: 'Premiere scripting timed out' }) },
      logger: { info: jest.fn(), error: jest.fn() },
    } as any;

    await expect(removeRangesDetailedForWorkflow(ctx, ranges, 'sequence-1')).resolves.toEqual([
      { success: false, status: 'bridge_failure', error: 'Premiere scripting timed out' },
    ]);
  });
});
