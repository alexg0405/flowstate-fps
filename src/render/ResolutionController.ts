/**
 * Decides render scale from observed frame times.
 *
 * The previous controller re-evaluated once every 120 frames and moved in 5 per cent
 * steps from 1.0 to a 0.65 floor, so reaching the floor took fourteen adjustments --
 * about twenty-eight seconds. It also averaged only the renderer's own timing, which
 * excludes simulation, React and compositing, so it under-read the true cost of a
 * frame and engaged late.
 *
 * This one samples true frame-to-frame delta, judges on a high percentile rather than
 * a mean so a few good frames cannot hide a bad run, and is deliberately asymmetric:
 * it drops fast to protect the frame budget and recovers slowly so it does not
 * oscillate around the threshold.
 */
export interface ResolutionControllerOptions {
  /** Frames between decisions. */
  readonly window: number;
  /** Percentile of the window used for the decision, 0..1. */
  readonly percentile: number;
  /** Above this frame time the scale drops. */
  readonly dropAboveMs: number;
  /** Below this frame time the scale recovers. Must sit under `dropAboveMs`. */
  readonly recoverBelowMs: number;
  readonly dropStep: number;
  readonly recoverStep: number;
  readonly minimumScale: number;
}

export const defaultResolutionOptions: ResolutionControllerOptions = {
  window: 20,
  percentile: 0.9,
  // 60 Hz is 16.7 ms. Drop once the nineteenth-worst frame in twenty misses it, and
  // only recover with real headroom, so the two thresholds cannot chatter.
  dropAboveMs: 18,
  recoverBelowMs: 13,
  dropStep: 0.12,
  recoverStep: 0.03,
  minimumScale: 0.65,
};

export class ResolutionController {
  private readonly samples: number[] = [];
  private scale = 1;

  constructor(private readonly options: ResolutionControllerOptions = defaultResolutionOptions) {}

  get current(): number {
    return this.scale;
  }

  reset(): void {
    this.samples.length = 0;
    this.scale = 1;
  }

  /** Feeds one frame's true delta and returns the scale to render at. */
  sample(frameMs: number): number {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return this.scale;
    this.samples.push(frameMs);
    if (this.samples.length < this.options.window) return this.scale;

    const ordered = [...this.samples].sort((a, b) => a - b);
    this.samples.length = 0;
    const index = Math.min(ordered.length - 1, Math.floor(ordered.length * this.options.percentile));
    const measured = ordered[index];

    if (measured > this.options.dropAboveMs) {
      this.scale = Math.max(this.options.minimumScale, this.scale - this.options.dropStep);
    } else if (measured < this.options.recoverBelowMs) {
      this.scale = Math.min(1, this.scale + this.options.recoverStep);
    }
    return this.scale;
  }
}
