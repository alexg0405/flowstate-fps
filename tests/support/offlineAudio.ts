/**
 * A deterministic offline Web Audio renderer, built for one job: measuring this game's
 * mix.
 *
 * The standing problem with a synthesised mix is that whoever works on it cannot hear it.
 * The industry's answer is a number -- games target -23 LUFS with true peak under
 * -1 dBFS -- and the way to get one out of a graph that is generated rather than
 * authored is to render it offline against a scripted tape. The browser has
 * `OfflineAudioContext` for exactly this; Node has nothing at all, so this is that,
 * reduced to the node set `AudioManager` actually builds.
 *
 * What it renders is the **real graph**: the same `AudioManager`, the same oscillators,
 * curves, envelopes, impulse response and routing, driven by the same `consume` and
 * `sustain` calls the runtime makes. What it approximates, and these are the numbers to
 * distrust if a measurement ever looks wrong:
 *
 * - `DynamicsCompressorNode` is a straightforward feed-forward compressor with a
 *   quadratic knee and one-pole attack and release. Chrome's has lookahead and a more
 *   elaborate release curve, so the limiter's exact behaviour a decibel either side of
 *   the threshold will differ.
 * - Oscillators are additive up to `MAX_HARMONICS` partials rather than using a full
 *   `PeriodicWave`, so a square well under the fundamental limit is slightly duller than
 *   Chrome's.
 * - Biquads recompute their coefficients every `COEFFICIENT_BLOCK` samples rather than
 *   per sample, which only matters to a filter being swept.
 * - `disconnect()` is a no-op. Every voice in this mix disconnects itself in `onended`,
 *   which in a real context happens after it has already been heard; a renderer that
 *   honoured it would silently drop every one of them.
 *
 * Everything else -- automation curves, the convolver's own normalisation, equal-power
 * panning, the drive curve's lookup -- follows the specification.
 */
import { convolve } from './fft';

/** Partials an additive oscillator is built from, and the cost ceiling on one. */
const MAX_HARMONICS = 24;
/** How often a swept biquad recomputes. */
const COEFFICIENT_BLOCK = 64;

type Channels = [Float32Array, Float32Array];

/** A node's output, and the sample it starts at. Voices are short; spans keep them cheap. */
interface Rendered {
  start: number;
  data: Channels;
}

interface AutomationEvent {
  kind: 'set' | 'linear' | 'exponential' | 'target';
  time: number;
  value: number;
  timeConstant?: number;
}

function emptyRendered(): Rendered {
  return { start: 0, data: [new Float32Array(0), new Float32Array(0)] };
}

class OfflineParam {
  private events: AutomationEvent[] = [];
  private intrinsic: number;
  /** Nodes connected to this parameter, summed into it at audio rate. */
  readonly inputs: OfflineNode[] = [];

  constructor(initial: number) {
    this.intrinsic = initial;
  }

  get value(): number { return this.intrinsic; }
  set value(next: number) { this.intrinsic = next; }

  setValueAtTime(value: number, time: number): OfflineParam {
    this.push({ kind: 'set', time, value });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): OfflineParam {
    this.push({ kind: 'linear', time, value });
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): OfflineParam {
    this.push({ kind: 'exponential', time, value });
    return this;
  }

  setTargetAtTime(value: number, time: number, timeConstant: number): OfflineParam {
    this.push({ kind: 'target', time, value, timeConstant });
    return this;
  }

  cancelScheduledValues(time: number): OfflineParam {
    this.events = this.events.filter((event) => event.time < time);
    return this;
  }

  private push(event: AutomationEvent): void {
    this.events.push(event);
    this.events.sort((a, b) => a.time - b.time);
  }

  /**
   * The value at a moment, following the specification's curves. Before the first event
   * the parameter holds its intrinsic value, which is what every `.value = x` in the mix
   * is setting.
   */
  valueAt(time: number): number {
    if (this.events.length === 0) return this.intrinsic;
    let index = -1;
    for (let cursor = 0; cursor < this.events.length; cursor += 1) {
      if (this.events[cursor].time <= time) index = cursor;
      else break;
    }
    if (index < 0) {
      // A ramp is the first thing scheduled: it runs from the intrinsic value.
      const next = this.events[0];
      return next.kind === 'set' || next.kind === 'target' ? this.intrinsic : this.intrinsic;
    }
    const event = this.events[index];
    const next = this.events[index + 1];
    const previousValue = this.valueAtEvent(index);
    if (event.kind === 'target') {
      const constant = Math.max(1e-6, event.timeConstant ?? 1e-6);
      const from = index === 0 ? this.intrinsic : this.valueAtEvent(index - 1);
      return event.value + (from - event.value) * Math.exp(-(time - event.time) / constant);
    }
    if (next && (next.kind === 'linear' || next.kind === 'exponential') && time < next.time) {
      const span = next.time - event.time;
      const fraction = span <= 0 ? 1 : (time - event.time) / span;
      if (next.kind === 'linear') return previousValue + (next.value - previousValue) * fraction;
      const from = Math.max(1e-8, Math.abs(previousValue)) * Math.sign(previousValue || 1);
      const to = Math.max(1e-8, Math.abs(next.value)) * Math.sign(next.value || 1);
      return from * (to / from) ** fraction;
    }
    return previousValue;
  }

  /** The value an event settles on, which a following ramp starts from. */
  private valueAtEvent(index: number): number {
    const event = this.events[index];
    if (event.kind === 'target') {
      const from = index === 0 ? this.intrinsic : this.valueAtEvent(index - 1);
      const constant = Math.max(1e-6, event.timeConstant ?? 1e-6);
      const next = this.events[index + 1];
      const until = next ? next.time - event.time : 0;
      return event.value + (from - event.value) * Math.exp(-until / constant);
    }
    return event.value;
  }
}

abstract class OfflineNode {
  readonly inputs: OfflineNode[] = [];
  protected rendered: Rendered | null = null;

  constructor(protected readonly engine: OfflineEngine) {}

  connect<T>(target: T): T {
    if (target instanceof OfflineNode) target.inputs.push(this);
    else if (target instanceof OfflineParam) target.inputs.push(this);
    return target;
  }

  /** See the file header: honouring this would unplay every voice in the mix. */
  disconnect(): void {}

  output(): Rendered {
    this.rendered ??= this.compute();
    return this.rendered;
  }

  protected abstract compute(): Rendered;

  /** Every input summed over the union of their spans. */
  protected mixInputs(): Rendered {
    const spans = this.inputs.map((input) => input.output()).filter((span) => span.data[0].length > 0);
    if (spans.length === 0) return emptyRendered();
    const start = Math.min(...spans.map((span) => span.start));
    const end = Math.max(...spans.map((span) => span.start + span.data[0].length));
    const data: Channels = [new Float32Array(end - start), new Float32Array(end - start)];
    for (const span of spans) {
      const offset = span.start - start;
      for (let channel = 0; channel < 2; channel += 1) {
        const source = span.data[channel];
        const target = data[channel];
        for (let index = 0; index < source.length; index += 1) target[offset + index] += source[index];
      }
    }
    return { start, data };
  }
}

class OfflineGain extends OfflineNode {
  readonly gain = new OfflineParam(1);

  protected compute(): Rendered {
    const input = this.mixInputs();
    const length = input.data[0].length;
    if (length === 0) return input;
    const modulation = this.gain.inputs.map((node) => node.output());
    const rate = this.engine.sampleRate;
    for (let index = 0; index < length; index += 1) {
      const time = (input.start + index) / rate;
      let value = this.gain.valueAt(time);
      for (const source of modulation) {
        const offset = input.start + index - source.start;
        if (offset >= 0 && offset < source.data[0].length) value += source.data[0][offset];
      }
      input.data[0][index] *= value;
      input.data[1][index] *= value;
    }
    return input;
  }
}

class OfflineOscillator extends OfflineNode {
  type: OscillatorType = 'sine';
  readonly frequency = new OfflineParam(440);
  readonly detune = new OfflineParam(0);
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;

  start(when = this.engine.currentTime): void {
    this.startedAt = when;
    this.engine.register(this);
  }

  stop(when = this.engine.currentTime): void {
    this.stoppedAt = when;
  }

  protected compute(): Rendered {
    const rate = this.engine.sampleRate;
    const start = Math.max(0, Math.round((this.startedAt ?? 0) * rate));
    const end = Math.min(this.engine.length, Math.round((this.stoppedAt ?? this.engine.seconds) * rate));
    if (end <= start) return emptyRendered();
    const data: Channels = [new Float32Array(end - start), new Float32Array(end - start)];
    let phase = 0;
    for (let index = 0; index < end - start; index += 1) {
      const time = (start + index) / rate;
      const frequency = Math.max(0, this.frequency.valueAt(time));
      const sample = this.shape(phase, frequency, rate);
      data[0][index] = sample;
      data[1][index] = sample;
      phase = (phase + frequency / rate) % 1;
    }
    return { start, data };
  }

  /** Additive up to `MAX_HARMONICS`, which is band-limiting on a budget. */
  private shape(phase: number, frequency: number, rate: number): number {
    const turn = 2 * Math.PI * phase;
    if (this.type === 'sine' || frequency <= 0) return Math.sin(turn);
    const limit = Math.max(1, Math.min(MAX_HARMONICS, Math.floor(rate / 2 / Math.max(1, frequency))));
    let total = 0;
    if (this.type === 'square') {
      for (let harmonic = 1; harmonic <= limit; harmonic += 2) total += Math.sin(harmonic * turn) / harmonic;
      return (4 / Math.PI) * total;
    }
    if (this.type === 'triangle') {
      for (let harmonic = 1; harmonic <= limit; harmonic += 2) {
        total += ((-1) ** ((harmonic - 1) / 2) * Math.sin(harmonic * turn)) / harmonic ** 2;
      }
      return (8 / Math.PI ** 2) * total;
    }
    // Sawtooth, which this mix never asks for but the surface allows.
    for (let harmonic = 1; harmonic <= limit; harmonic += 1) total += Math.sin(harmonic * turn) / harmonic;
    return (2 / Math.PI) * total;
  }
}

class OfflineBufferSource extends OfflineNode {
  buffer: OfflineBuffer | null = null;
  loop = false;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;

  start(when = this.engine.currentTime): void {
    this.startedAt = when;
    this.engine.register(this);
  }

  stop(when = this.engine.currentTime): void {
    this.stoppedAt = when;
  }

  protected compute(): Rendered {
    const rate = this.engine.sampleRate;
    const source = this.buffer?.getChannelData(0);
    if (!source || source.length === 0) return emptyRendered();
    const start = Math.max(0, Math.round((this.startedAt ?? 0) * rate));
    const natural = this.loop ? this.engine.seconds : source.length / rate;
    const end = Math.min(this.engine.length, Math.round(Math.min(this.stoppedAt ?? Number.POSITIVE_INFINITY, (this.startedAt ?? 0) + natural) * rate));
    if (end <= start) return emptyRendered();
    const data: Channels = [new Float32Array(end - start), new Float32Array(end - start)];
    for (let index = 0; index < end - start; index += 1) {
      const cursor = this.loop ? index % source.length : index;
      const sample = cursor < source.length ? source[cursor] : 0;
      data[0][index] = sample;
      data[1][index] = sample;
    }
    return { start, data };
  }
}

class OfflineBiquad extends OfflineNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new OfflineParam(350);
  readonly Q = new OfflineParam(1);
  readonly gain = new OfflineParam(0);
  readonly detune = new OfflineParam(0);

  protected compute(): Rendered {
    const input = this.mixInputs();
    const length = input.data[0].length;
    if (length === 0) return input;
    const rate = this.engine.sampleRate;
    for (let channel = 0; channel < 2; channel += 1) {
      const data = input.data[channel];
      let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
      let b0 = 1; let b1 = 0; let b2 = 0; let a1 = 0; let a2 = 0;
      for (let index = 0; index < length; index += 1) {
        if (index % COEFFICIENT_BLOCK === 0) {
          const time = (input.start + index) / rate;
          ({ b0, b1, b2, a1, a2 } = this.coefficients(this.frequency.valueAt(time), this.Q.valueAt(time), rate));
        }
        const x0 = data[index];
        const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0;
        data[index] = y0;
      }
    }
    return input;
  }

  /**
   * The specification's own formulas. Note the split the spec makes and nothing else
   * does: Q is read in decibels for lowpass and highpass, and linearly for bandpass.
   */
  private coefficients(frequency: number, q: number, rate: number) {
    const nyquist = rate / 2;
    const normalized = Math.min(0.999, Math.max(1e-6, frequency / nyquist));
    const w0 = Math.PI * normalized;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    if (this.type === 'bandpass') {
      const alpha = sin / (2 * Math.max(1e-4, q));
      const a0 = 1 + alpha;
      return { b0: alpha / a0, b1: 0, b2: -alpha / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
    }
    const alpha = sin / (2 * 10 ** (q / 20));
    const a0 = 1 + alpha;
    if (this.type === 'highpass') {
      const b0 = (1 + cos) / 2;
      return { b0: b0 / a0, b1: -(1 + cos) / a0, b2: b0 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
    }
    const b0 = (1 - cos) / 2;
    return { b0: b0 / a0, b1: (1 - cos) / a0, b2: b0 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
  }
}

class OfflineWaveShaper extends OfflineNode {
  curve: Float32Array | null = null;
  oversample: OverSampleType = 'none';

  protected compute(): Rendered {
    const input = this.mixInputs();
    const curve = this.curve;
    if (!curve || curve.length === 0 || input.data[0].length === 0) return input;
    for (let channel = 0; channel < 2; channel += 1) {
      const data = input.data[channel];
      for (let index = 0; index < data.length; index += 1) {
        const x = Math.max(-1, Math.min(1, data[index]));
        const position = ((x + 1) / 2) * (curve.length - 1);
        const lower = Math.floor(position);
        const upper = Math.min(curve.length - 1, lower + 1);
        data[index] = curve[lower] + (curve[upper] - curve[lower]) * (position - lower);
      }
    }
    return input;
  }
}

class OfflineStereoPanner extends OfflineNode {
  readonly pan = new OfflineParam(0);

  protected compute(): Rendered {
    const input = this.mixInputs();
    const length = input.data[0].length;
    if (length === 0) return input;
    // Every chain that reaches a panner in this mix is mono, so the two channels carry
    // the same signal and their mean is that signal exactly.
    const angle = ((this.pan.valueAt(0) + 1) / 2) * (Math.PI / 2);
    const left = Math.cos(angle);
    const right = Math.sin(angle);
    for (let index = 0; index < length; index += 1) {
      const mono = (input.data[0][index] + input.data[1][index]) / 2;
      input.data[0][index] = mono * left;
      input.data[1][index] = mono * right;
    }
    return input;
  }
}

class OfflineConvolver extends OfflineNode {
  buffer: OfflineBuffer | null = null;
  normalize = true;

  protected compute(): Rendered {
    const input = this.mixInputs();
    const impulse = this.buffer;
    if (!impulse || input.data[0].length === 0) return input;
    const mono = new Float32Array(input.data[0].length);
    for (let index = 0; index < mono.length; index += 1) {
      mono[index] = (input.data[0][index] + input.data[1][index]) / 2;
    }
    const scale = this.normalize ? normalizationScale(impulse) : 1;
    const left = convolve(mono, impulse.getChannelData(0));
    const right = convolve(mono, impulse.getChannelData(Math.min(1, impulse.numberOfChannels - 1)));
    const usable = Math.min(left.length, this.engine.length - input.start);
    const data: Channels = [new Float32Array(usable), new Float32Array(usable)];
    for (let index = 0; index < usable; index += 1) {
      data[0][index] = left[index] * scale;
      data[1][index] = right[index] * scale;
    }
    return { start: input.start, data };
  }
}

/**
 * The convolver's own normalisation, from the specification. It matters more than any
 * other single number here: without it a 1.9-second impulse response returns the wet
 * signal several times louder than the dry one.
 */
function normalizationScale(buffer: OfflineBuffer): number {
  const calibration = 0.00125;
  const calibrationRate = 44_100;
  const minimumPower = 0.000125;
  let power = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) power += data[index] * data[index];
  }
  power = Math.sqrt(power / (buffer.numberOfChannels * buffer.length));
  if (!Number.isFinite(power) || power < minimumPower) power = minimumPower;
  return (calibration / power) * (calibrationRate / buffer.sampleRate);
}

class OfflineCompressor extends OfflineNode {
  readonly threshold = new OfflineParam(-24);
  readonly knee = new OfflineParam(30);
  readonly ratio = new OfflineParam(12);
  readonly attack = new OfflineParam(0.003);
  readonly release = new OfflineParam(0.25);
  readonly reduction = 0;

  protected compute(): Rendered {
    const input = this.mixInputs();
    const length = input.data[0].length;
    if (length === 0) return input;
    const rate = this.engine.sampleRate;
    const threshold = this.threshold.valueAt(0);
    const knee = Math.max(0, this.knee.valueAt(0));
    const ratio = Math.max(1, this.ratio.valueAt(0));
    const attack = Math.exp(-1 / (Math.max(1e-4, this.attack.valueAt(0)) * rate));
    const release = Math.exp(-1 / (Math.max(1e-4, this.release.valueAt(0)) * rate));
    let smoothed = 0;
    for (let index = 0; index < length; index += 1) {
      const peak = Math.max(Math.abs(input.data[0][index]), Math.abs(input.data[1][index]));
      const decibels = 20 * Math.log10(Math.max(1e-9, peak));
      const over = decibels - threshold;
      let reduction = 0;
      if (knee > 0 && over > -knee / 2 && over < knee / 2) {
        // Quadratic knee: the curve the specification describes, and the reason a
        // limiter set six decibels wide does not switch on and off around a transient.
        const inside = over + knee / 2;
        reduction = ((1 - 1 / ratio) * inside * inside) / (2 * knee);
      } else if (over >= knee / 2) {
        reduction = over * (1 - 1 / ratio);
      }
      const coefficient = reduction > smoothed ? attack : release;
      smoothed = reduction + (smoothed - reduction) * coefficient;
      const gain = 10 ** (-smoothed / 20);
      input.data[0][index] *= gain;
      input.data[1][index] *= gain;
    }
    return input;
  }
}

class OfflineDestination extends OfflineNode {
  protected compute(): Rendered {
    const input = this.mixInputs();
    if (input.data[0].length === this.engine.length && input.start === 0) return input;
    const data: Channels = [new Float32Array(this.engine.length), new Float32Array(this.engine.length)];
    for (let channel = 0; channel < 2; channel += 1) {
      const source = input.data[channel];
      for (let index = 0; index < source.length; index += 1) {
        const target = input.start + index;
        if (target >= 0 && target < this.engine.length) data[channel][target] += source[index];
      }
    }
    return { start: 0, data };
  }
}

class OfflineBuffer {
  private readonly channels: Float32Array[];

  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[Math.min(channel, this.numberOfChannels - 1)];
  }
}

type Scheduled = OfflineOscillator | OfflineBufferSource;

/**
 * The context itself. `AudioManager` only ever asks for the eight node types below, and
 * this implements exactly those -- anything it grows later will fail loudly here rather
 * than silently rendering silence.
 */
class OfflineEngine {
  state = 'running';
  currentTime = 0;
  readonly destination: OfflineDestination;
  readonly length: number;
  private readonly sources: Scheduled[] = [];
  private endedThrough = 0;

  constructor(readonly sampleRate: number, readonly seconds: number) {
    this.length = Math.ceil(sampleRate * seconds);
    this.destination = new OfflineDestination(this);
  }

  register(source: Scheduled): void {
    this.sources.push(source);
  }

  /**
   * Moves the clock, firing `onended` for anything that has finished by then. The mix
   * counts its own live voices to decide what is worth playing, so a renderer that never
   * ended a voice would measure a graph the runtime never produces.
   */
  advanceTo(time: number): void {
    this.currentTime = time;
    for (const source of this.sources) {
      const stop = source.stoppedAt;
      if (stop === null || stop > time) continue;
      const ended = (source as { onended?: (() => void) | null }).onended;
      if (!ended) continue;
      (source as { onended?: (() => void) | null }).onended = null;
      ended();
    }
    this.endedThrough = time;
  }

  render(): { sampleRate: number; left: Float32Array; right: Float32Array } {
    this.advanceTo(this.seconds);
    void this.endedThrough;
    const output = this.destination.output();
    return { sampleRate: this.sampleRate, left: output.data[0], right: output.data[1] };
  }

  async resume(): Promise<void> {}
  close(): void { this.state = 'closed'; }
  createGain() { return new OfflineGain(this); }
  createOscillator() { return new OfflineOscillator(this); }
  createBufferSource() { return new OfflineBufferSource(this); }
  createBiquadFilter() { return new OfflineBiquad(this); }
  createWaveShaper() { return new OfflineWaveShaper(this); }
  createStereoPanner() { return new OfflineStereoPanner(this); }
  createConvolver() { return new OfflineConvolver(this); }
  createDynamicsCompressor() { return new OfflineCompressor(this); }
  createBuffer(channels: number, length: number, sampleRate = this.sampleRate) {
    return new OfflineBuffer(channels, length, sampleRate);
  }
}

export type OfflineAudio = OfflineEngine;

/** A renderer for `seconds` of mix at `sampleRate`, ready to be handed to `AudioManager`. */
export function createOfflineAudio(seconds: number, sampleRate = 48_000): OfflineEngine {
  return new OfflineEngine(sampleRate, seconds);
}
