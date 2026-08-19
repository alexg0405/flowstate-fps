import type { GhostTrack, Vec3 } from '../contracts';
import { ghostTrack } from '../content/config';

/** Centimetres per metre. Samples are stored integral to keep the save payload small. */
const UNITS_PER_METRE = 100;

/**
 * Records the path of a run against the run clock, and measures how far ahead or
 * behind a stored path the current run is.
 *
 * Sampling is driven by elapsed run time rather than by tick count, because the clock
 * freezes while the player is down and jumps forward by the death penalty. Indexing
 * by elapsed keeps two runs comparable at the same moment on the clock; a death shows
 * up as the ghost holding still, which is what actually happened.
 */
export class GhostRecorder {
  private readonly samples: number[] = [];

  constructor(private readonly levelId: string) {}

  /** Fills every sample slot the clock has passed, so gaps cannot open up. */
  record(elapsedSeconds: number, position: Vec3): void {
    if (elapsedSeconds > ghostTrack.maxSeconds) return;
    const due = Math.floor(elapsedSeconds / ghostTrack.intervalSeconds) + 1;
    const x = Math.round(position[0] * UNITS_PER_METRE);
    const y = Math.round(position[1] * UNITS_PER_METRE);
    const z = Math.round(position[2] * UNITS_PER_METRE);
    while (this.samples.length / 3 < due) this.samples.push(x, y, z);
  }

  /** Null when the run outgrew the storage budget before finishing. */
  track(): GhostTrack | null {
    if (this.samples.length === 0) return null;
    return { levelId: this.levelId, intervalSeconds: ghostTrack.intervalSeconds, samples: [...this.samples] };
  }
}

export class GhostPlayback {
  private readonly count: number;
  private matchedIndex = 0;

  constructor(private readonly track: GhostTrack) {
    this.count = Math.floor(track.samples.length / 3);
  }

  /**
   * Only a path recorded on the same route is worth racing; geometry decides where a
   * run can go, so a path from another level is noise.
   */
  static forLevel(track: GhostTrack | undefined, levelId: string): GhostPlayback | null {
    if (!track || track.levelId !== levelId) return null;
    const playback = new GhostPlayback(track);
    return playback.count > 0 ? playback : null;
  }

  /** Interpolated position at a moment on the run clock, or null once the path ends. */
  positionAt(elapsedSeconds: number): Vec3 | null {
    if (this.count === 0) return null;
    const exact = elapsedSeconds / this.track.intervalSeconds;
    if (exact >= this.count - 1) return this.count > 0 ? this.sample(this.count - 1) : null;
    const index = Math.max(0, Math.floor(exact));
    const alpha = exact - index;
    const from = this.sample(index);
    const to = this.sample(index + 1);
    return [
      from[0] + (to[0] - from[0]) * alpha,
      from[1] + (to[1] - from[1]) * alpha,
      from[2] + (to[2] - from[2]) * alpha,
    ];
  }

  /** True once the clock has run past the end of the recorded path. */
  finishedBy(elapsedSeconds: number): boolean {
    return elapsedSeconds / this.track.intervalSeconds >= this.count - 1;
  }

  /**
   * Seconds the player is ahead of (negative) or behind (positive) the record, found
   * by locating the point on the path closest to where the player is now and
   * comparing the clock readings. Comparing positions at equal time would only report
   * distance apart, which says nothing about who is winning.
   */
  deltaSeconds(elapsedSeconds: number, position: Vec3): number | null {
    if (this.count === 0) return null;
    const start = Math.max(0, this.matchedIndex - ghostTrack.matchBackSamples);
    const end = Math.min(this.count - 1, this.matchedIndex + ghostTrack.matchForwardSamples);
    let bestIndex = this.matchedIndex;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = start; index <= end; index += 1) {
      const offset = index * 3;
      const dx = this.track.samples[offset] / UNITS_PER_METRE - position[0];
      const dy = this.track.samples[offset + 1] / UNITS_PER_METRE - position[1];
      const dz = this.track.samples[offset + 2] / UNITS_PER_METRE - position[2];
      const distance = dx * dx + dy * dy + dz * dz;
      // `<=` so the later of two equally close points wins: on a route that revisits a
      // spot, the match should follow progress forward rather than stick to the past.
      if (distance <= bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    this.matchedIndex = bestIndex;
    return elapsedSeconds - bestIndex * this.track.intervalSeconds;
  }

  private sample(index: number): Vec3 {
    const offset = index * 3;
    return [
      this.track.samples[offset] / UNITS_PER_METRE,
      this.track.samples[offset + 1] / UNITS_PER_METRE,
      this.track.samples[offset + 2] / UNITS_PER_METRE,
    ];
  }
}
