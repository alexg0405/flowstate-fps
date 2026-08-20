import { describe, expect, it } from 'vitest';
import { presentation } from '../src/content/config';
import { countTo, resultsSequenceSeconds, stepDelaySeconds } from '../src/ui/sequence';

const running = (elapsed: number) => ({ elapsed, settled: false });

describe('reveal sequence timing', () => {
  it('lands a settled sequence on the exact value rather than an eased approximation', () => {
    // These are scores and split times, not decoration: 1829.97 points is a bug.
    expect(countTo(1830, { elapsed: 0, settled: true })).toBe(1830);
    expect(countTo(126.25, { elapsed: 0, settled: true }, 4)).toBe(126.25);
  });

  it('holds a number at zero until the line carrying it has arrived', () => {
    const delay = stepDelaySeconds(6);
    expect(countTo(1830, running(delay - 0.01), delay)).toBe(0);
    expect(countTo(1830, running(delay + 0.01), delay)).toBeGreaterThan(0);
  });

  it('counts up monotonically and decelerates onto the target', () => {
    const samples = [0.1, 0.3, 0.5, 0.7].map((elapsed) => countTo(1000, running(elapsed)));
    for (let index = 1; index < samples.length; index += 1) expect(samples[index]).toBeGreaterThan(samples[index - 1]);
    // Eased out, so more than half the distance is covered in the first half.
    expect(countTo(1000, running(presentation.resultsCountSeconds / 2))).toBeGreaterThan(500);
    expect(countTo(1000, running(presentation.resultsCountSeconds))).toBe(1000);
  });

  it('never overshoots the target, however long the sequence has been running', () => {
    expect(countTo(1830, running(60))).toBe(1830);
    expect(countTo(1830, running(-5))).toBe(0);
  });

  it('matches the stagger CSS multiplies the step index by', () => {
    expect(stepDelaySeconds(0)).toBe(0);
    expect(stepDelaySeconds(4)).toBeCloseTo(4 * presentation.resultsStaggerSeconds, 10);
  });

  it('runs long enough for the last staggered line to finish counting', () => {
    const lastLineEnds = stepDelaySeconds(presentation.resultsSteps) + presentation.resultsLineSeconds;
    expect(resultsSequenceSeconds()).toBeGreaterThanOrEqual(lastLineEnds);
    // And short enough that a player is not made to watch it between runs.
    expect(resultsSequenceSeconds()).toBeLessThan(3);
  });
});
