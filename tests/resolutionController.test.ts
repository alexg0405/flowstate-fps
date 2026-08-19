import { describe, expect, it } from 'vitest';
import { defaultResolutionOptions, ResolutionController } from '../src/render/ResolutionController';

const OPTIONS = defaultResolutionOptions;

/** Feeds `frames` frames of the given cost and returns the scale afterwards. */
function drive(controller: ResolutionController, frameMs: number, frames: number): number {
  let scale = controller.current;
  for (let frame = 0; frame < frames; frame += 1) scale = controller.sample(frameMs);
  return scale;
}

describe('render scale under load', () => {
  it('starts at full resolution', () => {
    expect(new ResolutionController().current).toBe(1);
  });

  it('holds still until it has a full window to judge', () => {
    const controller = new ResolutionController();
    expect(drive(controller, 40, OPTIONS.window - 1)).toBe(1);
    expect(controller.sample(40)).toBeLessThan(1);
  });

  it('reaches the floor in about a second rather than half a minute', () => {
    const controller = new ResolutionController();
    const framesToFloor = Math.ceil((1 - OPTIONS.minimumScale) / OPTIONS.dropStep) * OPTIONS.window;
    drive(controller, 40, framesToFloor);
    expect(controller.current).toBe(OPTIONS.minimumScale);
    // The old controller re-evaluated every 120 frames in 5 per cent steps: fourteen
    // adjustments, about twenty-eight seconds at 60 Hz.
    expect(framesToFloor / 60).toBeLessThan(2);
  });

  it('never drops below the floor however bad it gets', () => {
    const controller = new ResolutionController();
    expect(drive(controller, 500, OPTIONS.window * 40)).toBe(OPTIONS.minimumScale);
  });

  it('recovers more slowly than it drops', () => {
    const dropped = new ResolutionController();
    drive(dropped, 40, OPTIONS.window);
    const afterDrop = 1 - dropped.current;

    const recovering = new ResolutionController();
    drive(recovering, 40, OPTIONS.window * 3);
    const low = recovering.current;
    drive(recovering, 5, OPTIONS.window);
    const afterRecover = recovering.current - low;

    expect(afterDrop).toBeGreaterThan(0);
    expect(afterRecover).toBeGreaterThan(0);
    // Asymmetric on purpose: protect the budget quickly, give resolution back gently.
    expect(afterRecover).toBeLessThan(afterDrop);
  });

  it('returns to full resolution once the load lifts', () => {
    const controller = new ResolutionController();
    drive(controller, 40, OPTIONS.window * 4);
    expect(controller.current).toBe(OPTIONS.minimumScale);
    drive(controller, 4, OPTIONS.window * 40);
    expect(controller.current).toBe(1);
  });

  it('tolerates an isolated hitch rather than reacting to it', () => {
    const controller = new ResolutionController();
    // A ninetieth percentile discards the worst tenth by construction. One stutter in
    // twenty frames is not a sustained problem, and dropping for it would be the
    // oscillation the asymmetry exists to avoid.
    for (let frame = 0; frame < OPTIONS.window - 1; frame += 1) controller.sample(8);
    controller.sample(60);
    expect(controller.current).toBe(1);
  });

  it('drops once a real minority of frames misses the budget', () => {
    const controller = new ResolutionController();
    // A quarter of the window over budget is past what the percentile absorbs. A mean
    // would still read comfortably here, which is why the mean was the wrong measure.
    const bad = Math.ceil(OPTIONS.window * 0.25);
    for (let frame = 0; frame < OPTIONS.window - bad; frame += 1) controller.sample(8);
    for (let frame = 0; frame < bad; frame += 1) controller.sample(60);
    expect(controller.current).toBeLessThan(1);
  });

  it('leaves the scale alone in the band between the thresholds', () => {
    const controller = new ResolutionController();
    const between = (OPTIONS.dropAboveMs + OPTIONS.recoverBelowMs) / 2;
    expect(drive(controller, between, OPTIONS.window * 6)).toBe(1);
  });

  it('keeps a gap between the thresholds so it cannot chatter', () => {
    expect(OPTIONS.recoverBelowMs).toBeLessThan(OPTIONS.dropAboveMs);
  });

  it('ignores a delta that is not a usable measurement', () => {
    const controller = new ResolutionController();
    for (let frame = 0; frame < OPTIONS.window * 3; frame += 1) {
      controller.sample(frame % 2 === 0 ? Number.NaN : 0);
    }
    expect(controller.current).toBe(1);
  });

  it('forgets its history on reset', () => {
    const controller = new ResolutionController();
    drive(controller, 40, OPTIONS.window * 3);
    expect(controller.current).toBeLessThan(1);
    controller.reset();
    expect(controller.current).toBe(1);
    // A stale half-window must not carry into the next decision.
    expect(drive(controller, 40, OPTIONS.window - 1)).toBe(1);
  });
});
