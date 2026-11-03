import { rangeTools } from '../../tools/domains/range.js';

describe('remove_range verifies the Premiere operation response', () => {
  const removeRange = rangeTools.find((tool) => tool.name === 'remove_range')!;

  it('returns 0 when Premiere reports that native Extract failed inside the CEP envelope', async () => {
    const ctx = {
      bridge: { executeScript: jest.fn().mockResolvedValue({ success: true, result: { success: false, status: 'native_extract_unverified' } }) },
      logger: { info: jest.fn(), error: jest.fn() },
    } as any;

    await expect(removeRange.run(ctx, { start_time: 12.54, end_time: 16.34 } as any)).resolves.toBe(0);
  });

  it('returns 1 when Premiere confirms the ripple operation inside the CEP envelope', async () => {
    const ctx = {
      bridge: { executeScript: jest.fn().mockResolvedValue({ success: true, result: { success: true, status: 'completed' } }) },
      logger: { info: jest.fn(), error: jest.fn() },
    } as any;

    await expect(removeRange.run(ctx, { start_time: 12.54, end_time: 16.34 } as any)).resolves.toBe(1);
  });
});
