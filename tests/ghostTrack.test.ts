import { describe, expect, it } from 'vitest';
import type { GhostTrack } from '../src/contracts';
import { ghostTrack } from '../src/content/config';
import { GhostPlayback, GhostRecorder } from '../src/runtime/GhostRecorder';
import { migrateSaveData, recordRun, writeSave } from '../src/persistence/saveStore';
import { defaultSave } from '../src/content/config';

const INTERVAL = ghostTrack.intervalSeconds;

describe('recording a run path', () => {
  it('samples on the run clock, not on the frame rate', () => {
    const recorder = new GhostRecorder('white-line');
    // Two very different step counts covering the same span of run clock must produce
    // the same path, or a fast machine would record a different ghost.
    for (let step = 1; step <= 60; step += 1) recorder.record(step * (INTERVAL / 4), [step, 0, 0]);
    const dense = recorder.track()!;

    const sparse = new GhostRecorder('white-line');
    for (let step = 1; step <= 15; step += 1) sparse.record(step * INTERVAL, [step * 4, 0, 0]);

    expect(dense.samples.length).toBe(sparse.track()!.samples.length);
    expect(dense.intervalSeconds).toBe(INTERVAL);
    expect(dense.levelId).toBe('white-line');
  });

  it('fills the slots a frozen or jumped clock skipped', () => {
    const recorder = new GhostRecorder('white-line');
    recorder.record(0, [0, 1, 0]);
    // A death adds its penalty to the clock in one go. The path has to stay dense, and
    // holding position is the honest reading: the run did not move during it.
    recorder.record(1, [0, 1, 0]);
    const track = recorder.track()!;
    expect(track.samples.length / 3).toBe(Math.floor(1 / INTERVAL) + 1);
    const last = track.samples.slice(-3);
    expect(last).toEqual([0, 100, 0]);
  });

  it('stores nothing for a run that outgrew the budget', () => {
    const recorder = new GhostRecorder('white-line');
    recorder.record(ghostTrack.maxSeconds + 10, [5, 5, 5]);
    expect(recorder.track()).toBeNull();
  });

  it('quantizes to centimetres so the payload stays compact', () => {
    const recorder = new GhostRecorder('white-line');
    recorder.record(0, [1.234, -2.5, 3.006]);
    expect(recorder.track()!.samples.slice(0, 3)).toEqual([123, -250, 301]);
  });
});

describe('racing a recorded path', () => {
  /** A straight run down -Z at a constant 10 m/s. */
  function straightTrack(seconds = 10, speed = 10, levelId = 'white-line'): GhostTrack {
    const recorder = new GhostRecorder(levelId);
    for (let step = 0; step <= Math.round(seconds / INTERVAL); step += 1) {
      const time = step * INTERVAL;
      recorder.record(time, [0, 1, -time * speed]);
    }
    return recorder.track()!;
  }

  it('only races a path recorded on the same route', () => {
    expect(GhostPlayback.forLevel(straightTrack(1, 10, 'other-route'), 'white-line')).toBeNull();
    expect(GhostPlayback.forLevel(undefined, 'white-line')).toBeNull();
    expect(GhostPlayback.forLevel(straightTrack(1), 'white-line')).not.toBeNull();
  });

  it('interpolates between samples', () => {
    const playback = GhostPlayback.forLevel(straightTrack(), 'white-line')!;
    const midway = playback.positionAt(INTERVAL * 1.5)!;
    // Half a sample past the first metre of travel at 10 m/s.
    expect(midway[2]).toBeCloseTo(-INTERVAL * 1.5 * 10, 4);
    expect(midway[1]).toBeCloseTo(1, 4);
  });

  it('holds at the end of the path and reports it finished', () => {
    const playback = GhostPlayback.forLevel(straightTrack(2), 'white-line')!;
    expect(playback.finishedBy(1)).toBe(false);
    expect(playback.finishedBy(30)).toBe(true);
    const parked = playback.positionAt(30)!;
    expect(parked[2]).toBeCloseTo(-20, 1);
  });

  it('reports being ahead as a negative delta and behind as positive', () => {
    const track = straightTrack();
    // The record was at z = -50 after 5 s. Reaching it in 4 s is a second up.
    const ahead = GhostPlayback.forLevel(track, 'white-line')!;
    expect(ahead.deltaSeconds(4, [0, 1, -50])!).toBeCloseTo(-1, 2);

    const behind = GhostPlayback.forLevel(track, 'white-line')!;
    expect(behind.deltaSeconds(6, [0, 1, -50])!).toBeCloseTo(1, 2);

    const level = GhostPlayback.forLevel(track, 'white-line')!;
    expect(level.deltaSeconds(5, [0, 1, -50])!).toBeCloseTo(0, 2);
  });

  it('measures progress along the path rather than distance from it', () => {
    const playback = GhostPlayback.forLevel(straightTrack(), 'white-line')!;
    // Well off to the side, but level with where the record was at 5 s. Comparing
    // positions at equal time would only report how far apart they are, which says
    // nothing about who is winning.
    expect(playback.deltaSeconds(5, [40, 1, -50])!).toBeCloseTo(0, 1);
  });

  it('does not snap the comparison backwards across a route that doubles back', () => {
    const recorder = new GhostRecorder('white-line');
    // Out to z = -20 and straight back to the start.
    for (let step = 0; step <= Math.round(4 / INTERVAL); step += 1) {
      const time = step * INTERVAL;
      const leg = time <= 2 ? time : 4 - time;
      recorder.record(time, [0, 1, -leg * 10]);
    }
    const playback = GhostPlayback.forLevel(recorder.track()!, 'white-line')!;

    // Walk the comparison forward through the outbound leg first.
    for (let time = 0; time <= 2; time += 0.25) playback.deltaSeconds(time, [0, 1, -time * 10]);
    // Now on the return leg, at a point the outbound leg also passed through.
    const delta = playback.deltaSeconds(3, [0, 1, -10])!;
    // Matched against the return leg it has been tracking, not the outbound one it
    // already left behind, which would read as a full second of lead.
    expect(delta).toBeCloseTo(0, 1);
  });
});

describe('persisting a record path', () => {
  it('round-trips the path with the record it belongs to', () => {
    localStorage.clear();
    const recorder = new GhostRecorder('white-line');
    recorder.record(0, [1, 2, 3]);
    recorder.record(INTERVAL, [4, 5, 6]);
    const track = recorder.track()!;

    recordRun(defaultSave, 100, 1200, 0, [], 9, track);
    const stored = migrateSaveData(JSON.parse(localStorage.getItem('flowstate-fps-save-v1')!));
    expect(stored.bestRun?.ghost).toEqual(track);
  });

  it('drops a malformed path instead of failing the load', () => {
    localStorage.clear();
    const base = migrateSaveData(defaultSave);
    writeSave({
      ...base,
      bestRun: {
        timeSeconds: 100, score: 500, rank: 'B', deaths: 0, peakCombo: 4, splits: [],
        ghost: { levelId: 'white-line', intervalSeconds: 0, samples: [1, 2, 3] },
      },
    });
    expect(migrateSaveData(JSON.parse(localStorage.getItem('flowstate-fps-save-v1')!)).bestRun?.ghost).toBeUndefined();

    writeSave({
      ...base,
      bestRun: {
        timeSeconds: 100, score: 500, rank: 'B', deaths: 0, peakCombo: 4, splits: [],
        // A trailing partial sample would otherwise be read as a position.
        ghost: { levelId: 'white-line', intervalSeconds: INTERVAL, samples: [1, 2, 3, 4] },
      },
    });
    const trimmed = migrateSaveData(JSON.parse(localStorage.getItem('flowstate-fps-save-v1')!)).bestRun?.ghost;
    expect(trimmed?.samples).toEqual([1, 2, 3]);
  });

  it('keeps the record without a path when the run was too long to store one', () => {
    localStorage.clear();
    recordRun(defaultSave, 900, 400, 0, [], 2, undefined);
    expect(migrateSaveData(JSON.parse(localStorage.getItem('flowstate-fps-save-v1')!)).bestRun?.ghost).toBeUndefined();
  });
});
