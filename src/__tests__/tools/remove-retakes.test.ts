import { detectRetakeGroups, matchSrtCueRange, parseWordSrt } from '../../tools/domains/retakes.js';

describe('remove_retakes transcript analysis', () => {
  it('resolves model-proposed cut seconds to exact SRT cue boundaries', () => {
    const cues = parseWordSrt([
      '1\n00:00:01,000 --> 00:00:01,200\nThe',
      '2\n00:00:01,200 --> 00:00:01,450\nfirst',
      '3\n00:00:01,450 --> 00:00:01,700\nattempt',
      '4\n00:00:02,000 --> 00:00:02,200\nThe',
      '5\n00:00:02,200 --> 00:00:02,450\nnext',
      '6\n00:00:02,450 --> 00:00:02,700\nattempt',
    ].join('\n\n'));

    expect(matchSrtCueRange(cues, 1, 1.7)).toEqual({ firstIndex: 0, lastIndex: 2 });
    expect(matchSrtCueRange(cues, 1.01, 1.7)).toEqual({ firstIndex: 0, lastIndex: 2 });
    expect(matchSrtCueRange(cues, 1.1, 1.6)).toBeNull();
    expect(matchSrtCueRange(cues, -1, 1.7)).toBeNull();
  });

  it('parses word cues and selects a complete attempt over a missing-word retry', () => {
    const srt = [
      '1\n00:00:00,100 --> 00:00:00,250\nWe',
      '2\n00:00:00,300 --> 00:00:00,450\nneed',
      '3\n00:00:00,500 --> 00:00:00,650\nto',
      '4\n00:00:00,700 --> 00:00:00,850\nfinish',
      '5\n00:00:00,900 --> 00:00:01,050\nthe',
      '6\n00:00:01,100 --> 00:00:01,300\njob.',
      '7\n00:00:04,000 --> 00:00:04,150\nWe',
      '8\n00:00:04,200 --> 00:00:04,350\nneed',
      '9\n00:00:04,400 --> 00:00:04,550\nfinish',
      '10\n00:00:04,600 --> 00:00:04,750\nthe',
      '11\n00:00:04,800 --> 00:00:05,000\njob',
    ].join('\n\n');

    const cues = parseWordSrt(srt);
    const groups = detectRetakeGroups(cues);

    expect(cues).toHaveLength(11);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.takes).toHaveLength(2);
    expect(groups[0]?.best?.text).toBe('We need to finish the job.');
  });

  it('leaves equally scored repeated takes unresolved', () => {
    const cues = parseWordSrt([
      '1\n00:00:00,100 --> 00:00:00,250\nWe',
      '2\n00:00:00,300 --> 00:00:00,450\nneed',
      '3\n00:00:00,500 --> 00:00:00,650\nto',
      '4\n00:00:00,700 --> 00:00:00,850\nfinish',
      '5\n00:00:00,900 --> 00:00:01,050\nthe',
      '6\n00:00:01,100 --> 00:00:01,300\njob.',
      '7\n00:00:04,000 --> 00:00:04,150\nWe',
      '8\n00:00:04,200 --> 00:00:04,350\nneed',
      '9\n00:00:04,400 --> 00:00:04,550\nto',
      '10\n00:00:04,600 --> 00:00:04,750\nfinish',
      '11\n00:00:04,800 --> 00:00:04,950\nthe',
      '12\n00:00:05,000 --> 00:00:05,200\njob.',
    ].join('\n\n'));

    const groups = detectRetakeGroups(cues);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.best).toBeNull();
  });
});
