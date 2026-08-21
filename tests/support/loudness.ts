/**
 * ITU-R BS.1770-4 loudness and true peak, which is what the industry means when it says
 * a mix is too loud.
 *
 * Games target **-23 LUFS ±2** measured over half an hour of representative play, with
 * true peak never above **-1 dBFS**. No asset in this game lasts half an hour, so the
 * numbers that matter here are short-term and momentary loudness -- the same emphasis
 * the game-audio literature puts on them for the same reason -- plus a true peak that
 * says whether a moment of the mix clipped the output.
 *
 * The K-weighting coefficients below are the standard's own, which are specified at
 * 48 kHz; `measureMix` refuses any other rate rather than silently mis-weighting.
 */

/** Stage one: a high shelf standing in for the acoustic effect of a head. */
const SHELF = {
  b: [1.535_124_859_586_97, -2.691_696_189_406_38, 1.198_392_810_852_85],
  a: [1, -1.690_659_293_182_41, 0.732_480_774_215_85],
} as const;
/** Stage two: the RLB high-pass, which takes the low end out of the measurement. */
const HIGHPASS = {
  b: [1, -2, 1],
  a: [1, -1.990_047_454_833_98, 0.990_072_250_366_21],
} as const;

const REQUIRED_RATE = 48_000;
/** The standard's own offset, so a full-scale sine reads as 0 LUFS. */
const LOUDNESS_OFFSET = -0.691;
/** Momentary loudness is a 400 ms window; short-term is three seconds. */
const MOMENTARY_SECONDS = 0.4;
const SHORT_TERM_SECONDS = 3;
/** Blocks overlap by three quarters, as the standard's gating requires. */
const HOP_SECONDS = 0.1;
/** Blocks quieter than this contribute nothing to the integrated figure. */
const ABSOLUTE_GATE_LUFS = -70;
/** And the relative gate, in loudness units under the ungated mean. */
const RELATIVE_GATE_LU = -10;

export interface MixMeasurement {
  /** Peak of the reconstructed waveform, in dBFS. Above -1 is the thing to fix. */
  truePeakDb: number;
  /** Highest sample in the rendered signal, for comparison with the above. */
  samplePeakDb: number;
  /** The loudest 400 ms of the tape. */
  maxMomentaryLufs: number;
  /** The loudest three seconds of it. */
  maxShortTermLufs: number;
  /** Gated loudness over the whole tape, which is the figure a target is set against. */
  integratedLufs: number;
}

function biquad(signal: Float32Array, coefficients: { b: readonly number[]; a: readonly number[] }): Float32Array {
  const { b, a } = coefficients;
  const output = new Float32Array(signal.length);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let index = 0; index < signal.length; index += 1) {
    const x0 = signal[index];
    const y0 = b[0] * x0 + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    output[index] = y0;
  }
  return output;
}

/** Mean square of each overlapping window, which every loudness figure is built from. */
function windowPower(channels: readonly Float32Array[], rate: number, seconds: number): number[] {
  const size = Math.round(rate * seconds);
  const hop = Math.round(rate * HOP_SECONDS);
  const weighted = channels.map((channel) => biquad(biquad(channel, SHELF), HIGHPASS));
  const powers: number[] = [];
  for (let start = 0; start + size <= weighted[0].length; start += hop) {
    let total = 0;
    for (const channel of weighted) {
      let sum = 0;
      for (let index = start; index < start + size; index += 1) sum += channel[index] * channel[index];
      total += sum / size;
    }
    powers.push(total);
  }
  return powers;
}

function loudnessOf(power: number): number {
  return power <= 0 ? Number.NEGATIVE_INFINITY : LOUDNESS_OFFSET + 10 * Math.log10(power);
}

/**
 * Four-times oversampled peak, via a windowed-sinc interpolator. A signal can pass
 * between two samples at a level neither of them reports, and a limiter that never sees
 * a sample over full scale can still hand the converter one.
 */
function truePeak(channel: Float32Array): number {
  const factor = 4;
  const taps = 32;
  const kernel = new Float32Array(taps * factor);
  const centre = (taps * factor - 1) / 2;
  for (let index = 0; index < kernel.length; index += 1) {
    const position = (index - centre) / factor;
    const sinc = position === 0 ? 1 : Math.sin(Math.PI * position) / (Math.PI * position);
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (kernel.length - 1));
    kernel[index] = sinc * window;
  }
  let peak = 0;
  for (let sample = 0; sample < channel.length; sample += 1) {
    for (let phase = 0; phase < factor; phase += 1) {
      let total = 0;
      for (let tap = 0; tap < taps; tap += 1) {
        const source = sample - tap + Math.floor(taps / 2);
        if (source < 0 || source >= channel.length) continue;
        total += channel[source] * kernel[phase + tap * factor];
      }
      peak = Math.max(peak, Math.abs(total));
    }
  }
  return peak;
}

export function measureMix(rendered: { sampleRate: number; left: Float32Array; right: Float32Array }): MixMeasurement {
  if (rendered.sampleRate !== REQUIRED_RATE) {
    throw new Error(`loudness is specified at ${REQUIRED_RATE} Hz; got ${rendered.sampleRate}`);
  }
  const channels = [rendered.left, rendered.right];
  const momentary = windowPower(channels, rendered.sampleRate, MOMENTARY_SECONDS);
  const shortTerm = windowPower(channels, rendered.sampleRate, SHORT_TERM_SECONDS);

  // The gated integrated figure: drop everything under the absolute gate, take the mean
  // of what is left, then drop everything ten units under *that* and take it again.
  const above = momentary.filter((power) => loudnessOf(power) > ABSOLUTE_GATE_LUFS);
  const ungated = above.reduce((total, power) => total + power, 0) / Math.max(1, above.length);
  const relative = loudnessOf(ungated) + RELATIVE_GATE_LU;
  const gated = above.filter((power) => loudnessOf(power) > relative);
  const integrated = gated.length === 0
    ? Number.NEGATIVE_INFINITY
    : loudnessOf(gated.reduce((total, power) => total + power, 0) / gated.length);

  const sample = Math.max(...channels.map((channel) => channel.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0)));
  const reconstructed = Math.max(...channels.map(truePeak));
  const decibels = (value: number) => (value <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(value));
  return {
    truePeakDb: decibels(reconstructed),
    samplePeakDb: decibels(sample),
    maxMomentaryLufs: momentary.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...momentary.map(loudnessOf)),
    maxShortTermLufs: shortTerm.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...shortTerm.map(loudnessOf)),
    integratedLufs: integrated,
  };
}
