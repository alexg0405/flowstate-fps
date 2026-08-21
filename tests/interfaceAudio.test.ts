import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameEvent } from '../src/contracts';
import { AudioManager, mixKey } from '../src/audio/AudioManager';
import { cueFor, installInterfaceAudio } from '../src/audio/interfaceAudio';

interface Voice { frequency: number; gain: number; type: string; startAt: number; filter: string | null }
/**
 * `startAt` is the envelope's own start, which is the only clock a noise layer has, and
 * `seconds` is where that envelope was told to reach silence. Decay length is the most
 * audible thing about a transient of this length -- far more so than a two per cent
 * detune -- so it has to be observable or the variation cannot be tested at all.
 */
interface Noise { cutoff: number; gain: number; filter: string; startAt: number; seconds: number }
/** An automation written to a gain node that belongs to no voice: the bus, ducking. */
interface Duck { value: number; at: number }

/**
 * jsdom has no Web Audio at all, so the bus is exercised against a recorder that
 * implements exactly the surface `AudioManager` uses. Without it these cues would be
 * typechecked and never heard by anything -- which is how the bug in AUDIT.md
 * section 5, where taking damage played the hit-confirm sound, survived as long as
 * it did.
 *
 * Voices are attributed by construction order, which is the only signal available: a
 * source node is created, then optionally a filter, then the gain whose envelope is
 * written. Attributing at the moment the gain is *created* rather than when it is
 * written is what makes the sub layer land in `voices` with its lowpass named, instead
 * of leaving a stray cutoff behind for the next node to pick up.
 */
function recordingContext() {
  const voices: Voice[] = [];
  const noises: Noise[] = [];
  const ducks: Duck[] = [];
  /** Which shared bus each voice was connected to, in order, so sends are observable. */
  const sends: string[] = [];
  /** Every cutoff each filter was ever set to, so a swept filter is observable. */
  const filterCutoffs: number[][] = [];
  /**
   * The gains built with the graph, in construction order. Only the bus is ever ducked, so
   * only the bus records into `ducks`; the bed's own gains would otherwise look like a
   * duck every time `sustain` moved them.
   */
  // The bed's two per-oscillator balance gains are not in this list on purpose: they are
  // created straight after an oscillator, so they are attributed to it as voices. What is
  // left source-less is the bus, the two sends, the two rooms they crossfade between, and
  // the bed's four output gains -- the pulse's depth among them, which is built before its
  // own oscillator for exactly this reason.
  const shared: string[] = ['bus', 'master', 'wetNear', 'wetFar', 'interior', 'exterior', 'floor', 'harmonic', 'drive', 'pulse', 'pulseDepth'];
  const bedAutomation: { node: string; value: number }[] = [];
  /** Every level written to the player's own gain, which sits after the ducked bus. */
  const volumes: number[] = [];
  /** Pitches a held oscillator was moved to, which is how the bed's key is observable. */
  const pitchTargets: { from: number; to: number }[] = [];
  /** Levels written to the two reverb sends, which a live chain opens. */
  const sendAutomation: { node: string; value: number }[] = [];
  /** Every pan a placed voice was given, in the order the voices were built. */
  const pans: number[] = [];
  /** Each generated impulse response, so the two rooms are observable. */
  const impulses: { length: number }[] = [];
  /** How long each tonal voice was scheduled for, in `voices` order. */
  const durations: number[] = [];
  let sharedCount = 0;

  class Param {
    value = 0;
    constructor(
      private readonly onSet?: (value: number, at: number) => void,
      private readonly onTarget?: (value: number) => void,
      private readonly onRamp?: (at: number) => void,
    ) {}
    setValueAtTime(value: number, at: number) { this.value = value; this.onSet?.(value, at); return this; }
    exponentialRampToValueAtTime(_value: number, at: number): Param { this.onRamp?.(at); return this; }
    linearRampToValueAtTime() { return this; }
    setTargetAtTime(value: number, _at: number, _constant: number): Param { this.onTarget?.(value); return this; }
    cancelScheduledValues() { return this; }
  }
  class Node {
    connect(next: Node) { return next; }
    disconnect() {}
  }
  class Oscillator extends Node {
    type = '';
    startedAt = 0;
    pitch = 0;
    onended: (() => void) | null = null;
    /**
     * Pitch is written three ways in this codebase and all three have to be observable:
     * as `.value` when the bed's held oscillators are built, as `setValueAtTime` for
     * every transient voice, and as `setTargetAtTime` when a live chain transposes the
     * bed -- which is the only form a *moved* oscillator can take, since one cannot be
     * restarted once stopped.
     */
    readonly frequency: {
      value: number;
      setValueAtTime(value: number, at: number): unknown;
      exponentialRampToValueAtTime(value: number, at: number): unknown;
      setTargetAtTime(value: number, at: number, constant: number): unknown;
    };
    constructor() {
      super();
      const owner = this;
      this.frequency = {
        get value() { return owner.pitch; },
        set value(next: number) { owner.pitch = next; },
        setValueAtTime(value: number, at: number) { owner.pitch = value; owner.startedAt = at; return this; },
        exponentialRampToValueAtTime() { return this; },
        setTargetAtTime(value: number) { pitchTargets.push({ from: owner.pitch, to: value }); return this; },
      };
    }
    start() {}
    // Context time never advances in here, so a stop time *is* a duration. Recorded in
    // construction order, which is the same order voices are pushed in -- the convention
    // the rest of this double already runs on.
    stop(at = 0) { durations.push(at); }
  }

  type Source = { kind: 'osc'; node: Oscillator } | { kind: 'buffer' };
  let pendingSource: Source | null = null;
  let pendingFilter: { type: string; frequency: number } | null = null;

  const context = {
    state: 'running',
    currentTime: 0,
    sampleRate: 48_000,
    destination: new Node(),
    async resume() {},
    createGain() {
      const source = pendingSource;
      const filter = pendingFilter;
      pendingSource = null;
      pendingFilter = null;
      const node = new Node() as Node & { gain: Param; label?: string };
      if (!source) {
        // The shared nodes are built first and in a known order: the bus everything
        // passes through, then the two reverb sends. Only the bus is ever automated,
        // and unlike a voice envelope its *ramps* are the interesting part -- the duck
        // is a ramp down, a hold, and a ramp back -- so they are recorded too.
        node.label = shared[sharedCount] ?? `shared-${sharedCount}`;
        sharedCount += 1;
        const label = node.label;
        const record = label === 'bus' ? ducks : null;
        // The master and the two sends are kept out of `bedAutomation` deliberately.
        // One is the player's level and the others are the size of the room; neither is
        // a layer of the bed, and tests that assert the bed went silent would otherwise
        // be reading a volume slider or a reverb send.
        const push = (value: number) => {
          if (label === 'master') volumes.push(value);
          // The two sends and the two rooms they crossfade between all record as sends
          // rather than as bed layers, for the reason above: one is how wet a cue is and
          // the other is how big the room is, and neither is a layer of the bed. A test
          // asserting the bed went silent would otherwise be reading a reverb.
          else if (label === 'wetNear' || label === 'wetFar' || label === 'interior' || label === 'exterior') sendAutomation.push({ node: label, value });
          else bedAutomation.push({ node: label ?? '?', value });
        };
        const param = new Param((value, at) => {
          if (record) record.push({ value, at });
          else push(value);
        });
        param.exponentialRampToValueAtTime = (value: number, at: number) => {
          if (record) record.push({ value, at });
          return param;
        };
        param.setTargetAtTime = (value: number) => {
          if (!record) push(value);
          return param;
        };
        node.gain = param;
        return node;
      }
      node.connect = (next: Node & { label?: string }) => {
        if (next.label) sends.push(next.label);
        return next;
      };
      let pending: Noise | null = null;
      node.gain = new Param((value, at) => {
        if (source.kind === 'osc') {
          voices.push({ frequency: source.node.pitch, gain: value, type: source.node.type, startAt: source.node.startedAt, filter: filter?.type ?? null });
        } else if (filter) {
          // A noise layer has no oscillator to carry a start time, so the envelope's own
          // is it -- and it is the same number `noise` passes to `source.start`.
          pending = { cutoff: filter.frequency, gain: value, filter: filter.type, startAt: at, seconds: 0 };
          noises.push(pending);
        }
      }, undefined, (at) => {
        // The decay, which is written as a ramp to silence immediately after the level.
        if (pending) pending.seconds = at - pending.startAt;
      });
      return node;
    },
    createOscillator() {
      const made = new Oscillator();
      pendingSource = { kind: 'osc', node: made };
      return made;
    },
    createBufferSource() {
      pendingSource = { kind: 'buffer' };
      return Object.assign(new Node(), { buffer: null, loop: false, onended: null as (() => void) | null, start() {}, stop() {} });
    },
    createBiquadFilter() {
      const record = { type: '', frequency: 0 };
      const cutoffs: number[] = [];
      filterCutoffs.push(cutoffs);
      const node = new Node() as Node & { type: string; frequency: { value: number }; Q: { value: number } };
      Object.defineProperty(node, 'type', {
        set(value: string) { record.type = value; pendingFilter = record; },
        get() { return record.type; },
      });
      node.frequency = {
        set value(next: number) { record.frequency = next; cutoffs.push(next); pendingFilter = record; },
        get value() { return record.frequency; },
        setTargetAtTime(next: number) { cutoffs.push(next); return this; },
        setValueAtTime(next: number) { cutoffs.push(next); return this; },
      } as unknown as { value: number };
      node.Q = { value: 0 };
      return node;
    },
    createWaveShaper() {
      return Object.assign(new Node(), { curve: null as unknown });
    },
    createStereoPanner() {
      const node = new Node() as Node & { pan: { value: number } };
      let placed = 0;
      node.pan = {
        get value() { return placed; },
        set value(next: number) { placed = next; pans.push(next); },
      };
      return node;
    },
    createConvolver() {
      return Object.assign(new Node(), { buffer: null as unknown });
    },
    createDynamicsCompressor() {
      return Object.assign(new Node(), {
        threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 },
        attack: { value: 0 }, release: { value: 0 },
      });
    },
    createBuffer(channels: number, length: number) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      // Two channels is an impulse response; one is the noise buffer everything else
      // runs on. Recording their lengths is how the two rooms become observable at all.
      if (channels === 2) impulses.push({ length });
      return { numberOfChannels: channels, getChannelData: (channel: number) => data[channel] };
    },
    close() {},
  };
  return { context, voices, noises, ducks, sends, bedAutomation, filterCutoffs, volumes, pitchTargets, sendAutomation, durations, pans, impulses };
}

async function busWith(recorder: ReturnType<typeof recordingContext>): Promise<AudioManager> {
  vi.stubGlobal('AudioContext', function AudioContextStub(this: unknown) { return recorder.context; } as unknown as typeof AudioContext);
  const bus = new AudioManager();
  await bus.resume();
  return bus;
}

beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('interface cues on the synth bus', () => {
  it('says nothing at all before a gesture has opened the context', () => {
    const bus = new AudioManager();
    // No `resume`, so no context. This is the state every page starts in.
    expect(() => bus.cue('confirm')).not.toThrow();
    expect(() => bus.cue('result')).not.toThrow();
  });

  it('keeps hover an order of magnitude under the hit confirm', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.cue('hover');
    const [hover] = recorder.voices;
    expect(hover).toBeDefined();
    // The confirm a landed body shot plays is 0.055. A menu that ticks anywhere near
    // that under the pointer is a menu the player turns off.
    expect(hover.gain).toBeLessThan(0.055 / 3);
  });

  it('sits the interface above the run rather than below it', async () => {
    // The run is built under 200 Hz now, so the separation between the two is register
    // as well as material: an interface cue in the same octave as a gunshot is a cue
    // the player mistakes for one.
    const pitches: number[] = [];
    for (const kind of ['hover', 'select', 'confirm', 'cancel'] as const) {
      const recorder = recordingContext();
      const bus = await busWith(recorder);
      bus.cue(kind);
      pitches.push(...recorder.voices.map((voice) => voice.frequency));
    }
    expect(Math.min(...pitches)).toBeGreaterThan(190);
    // And still well clear of the beep register this pass exists to remove.
    expect(Math.max(...pitches)).toBeLessThan(700);
  });

  it('rises to confirm and falls to cancel, so the two are not the same event', async () => {
    const confirmRecorder = recordingContext();
    const confirmBus = await busWith(confirmRecorder);
    confirmBus.cue('confirm');
    const confirmPitches = confirmRecorder.voices.map((voice) => voice.frequency);
    expect(confirmPitches.length).toBeGreaterThanOrEqual(2);
    expect(confirmPitches.at(-1)!).toBeGreaterThan(confirmPitches[0]);

    const cancelRecorder = recordingContext();
    const cancelBus = await busWith(cancelRecorder);
    cancelBus.cue('cancel');
    expect(cancelRecorder.voices).toHaveLength(1);
    expect(cancelRecorder.voices[0].frequency).toBeLessThan(confirmPitches[0]);
  });

  it('holds the results stinger back until the completion cue has rung out', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.cue('result');
    // `complete` now runs 0.9 s of sub and 0.6 s of tone from zero, plus a second
    // voice from 0.18. Landing the stinger on top of it is how two cues get confused
    // for one.
    const earliest = Math.min(...recorder.voices.map((voice) => voice.startAt));
    expect(earliest).toBeGreaterThan(0.9);
  });

  it('leaves no part of the stinger sounding before the delay, noise included', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.cue('result');
    // `crack` takes no delay, so a percussive layer here would fire at zero however
    // late the notes were scheduled. There is deliberately no noise in this cue.
    expect(recorder.noises).toHaveLength(0);
  });

  it('builds every cue from square and triangle, leaving the sine pairs to the run', async () => {
    const shapes = new Set<string>();
    for (const kind of ['hover', 'select', 'confirm', 'cancel', 'result'] as const) {
      const recorder = recordingContext();
      const bus = await busWith(recorder);
      bus.cue(kind);
      for (const voice of recorder.voices) shapes.add(voice.type);
    }
    // `checkpoint`, `split` and `complete` are the sine voices in the mix; nothing
    // the interface plays should be mistakable for one of them.
    expect(shapes.has('sine')).toBe(false);
    expect([...shapes].every((shape) => shape === 'square' || shape === 'triangle')).toBe(true);
  });
});

describe('the mix distinguishes a dodge from a hit', () => {
  it('rings louder and higher than the confirm blip, so a refused round is unmistakable', async () => {
    const dodgeRecorder = recordingContext();
    const dodgeBus = await busWith(dodgeRecorder);
    dodgeBus.consume([{ id: 1, tick: 1, kind: 'dodge', value: 10, targetEntityId: 1, sourceEntityId: 2 }]);

    const hitRecorder = recordingContext();
    const hitBus = await busWith(hitRecorder);
    hitBus.consume([{ id: 1, tick: 1, kind: 'hit', value: 34, targetEntityId: 7, sourceEntityId: 1 }]);

    // A perfect dodge fires at the moment a telegraph is still ringing, so it has to
    // cut through it: more layers, and a louder one than the body-shot confirm.
    const layers = (recorder: { voices: unknown[]; noises: unknown[] }) => recorder.voices.length + recorder.noises.length;
    expect(layers(dodgeRecorder)).toBeGreaterThan(layers(hitRecorder));
    const loudestDodge = Math.max(...dodgeRecorder.voices.map((voice) => voice.gain));
    const loudestHit = Math.max(...hitRecorder.voices.map((voice) => voice.gain));
    expect(loudestDodge).toBeGreaterThan(loudestHit);
    // And it rises, where taking damage falls -- the two must never read as the
    // same event, which is the bug AUDIT.md section 5 records.
    const pitches = dodgeRecorder.voices.map((voice) => voice.frequency);
    expect(pitches.at(-1)!).toBeGreaterThan(pitches[0]);
  });

  it('is not the telegraph it answers', async () => {
    const telegraphRecorder = recordingContext();
    const telegraphBus = await busWith(telegraphRecorder);
    telegraphBus.consume([{ id: 1, tick: 1, kind: 'enemyTelegraph', value: 0.42, sourceEntityId: 2, targetEntityId: 1 }]);

    const dodgeRecorder = recordingContext();
    const dodgeBus = await busWith(dodgeRecorder);
    dodgeBus.consume([{ id: 1, tick: 1, kind: 'dodge', value: 10, targetEntityId: 1, sourceEntityId: 2 }]);

    // Both live in the low register now, so the dodge is no longer distinguished by
    // being higher than the warning -- it is distinguished by weight and by punctuation.
    // It is half again as loud, it has a body layer the swell does not, and it is the
    // only one of the two that stops the rest of the mix.
    const loudest = (recorder: { voices: { gain: number }[] }) => Math.max(...recorder.voices.map((voice) => voice.gain));
    expect(loudest(dodgeRecorder)).toBeGreaterThan(loudest(telegraphRecorder) * 1.5);
    expect(dodgeRecorder.noises.filter((noise) => noise.filter === 'lowpass').length).toBeGreaterThan(0);
    expect(telegraphRecorder.noises.filter((noise) => noise.filter === 'lowpass')).toHaveLength(0);
    expect(dodgeRecorder.ducks.length).toBeGreaterThan(0);
    expect(telegraphRecorder.ducks).toHaveLength(0);
  });

  it('keeps the warning locatable without making it a beep', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.consume(
      [{ id: 1, tick: 1, kind: 'enemyTelegraph', value: 0.42, sourceEntityId: 2, targetEntityId: 1, origin: [8, 0, -6], position: [8, 0, -6] }],
      { position: [0, 0, 0], yaw: 0, playerId: 1 },
    );
    // One short tick at the front, so the ear can place where it came from, and nothing
    // else above the register the rest of the mix lives in.
    expect(recorder.noises.filter((noise) => noise.filter === 'bandpass')).toHaveLength(1);
    expect(Math.max(...recorder.voices.map((voice) => voice.frequency))).toBeLessThan(200);
  });
});

describe('the mix has weight, space and punctuation', () => {
  const at = (kind: string, extra: Record<string, unknown> = {}) => ({ id: 7, tick: 1, kind, ...extra } as never);

  it('ducks the whole bus on a kill and lets it back to the resting level', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.consume([at('kill', { targetEntityId: 7, value: 100 })]);

    // Down hard, held, then back. The floor has to be a real reduction and the last
    // value written has to be the level it started from, or the mix stays quiet.
    expect(recorder.ducks.length).toBeGreaterThanOrEqual(3);
    const values = recorder.ducks.map((duck) => duck.value);
    const resting = values[0];
    expect(Math.min(...values)).toBeLessThan(resting * 0.6);
    expect(values.at(-1)).toBeCloseTo(resting, 6);
    // And the attack is far quicker than the release: a slow duck sounds like a
    // mistake, a slow recovery sounds like a decision.
    const times = recorder.ducks.map((duck) => duck.at);
    expect(times[1] - times[0]).toBeLessThan((times.at(-1)! - times[0]) / 5);
  });

  it('refuses a second duck inside a live one, so a run does not pump', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.consume([at('kill', { targetEntityId: 7 })]);
    const afterFirst = recorder.ducks.length;
    // Context time does not advance in the recorder, so this second kill is inside the
    // first duck's release by construction -- which is the case being guarded.
    bus.consume([at('kill', { id: 8, targetEntityId: 8 })]);
    expect(recorder.ducks).toHaveLength(afterFirst);
  });

  it('leaves the interface out of the duck entirely', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    for (const kind of ['hover', 'select', 'confirm', 'cancel', 'result'] as const) bus.cue(kind);
    // The duck is the run's punctuation. A menu that pulled the mix down under the
    // pointer would spend the effect on nothing.
    expect(recorder.ducks).toHaveLength(0);
  });

  it('gives a landed slash material a whiff does not have', async () => {
    const whiffRecorder = recordingContext();
    const whiffBus = await busWith(whiffRecorder);
    whiffBus.consume([at('melee', { sourceEntityId: 1 })]);

    const cutRecorder = recordingContext();
    const cutBus = await busWith(cutRecorder);
    cutBus.consume([at('melee', { sourceEntityId: 1, targetEntityId: 9 })]);

    // Not the same sound at two levels. The whiff is dark air and nothing else; the cut
    // has a transient for definition and a driven sub under it. This is the primary verb
    // and the cue heard most, so it is the one that most has to have weight.
    expect(cutRecorder.noises.length).toBeGreaterThan(whiffRecorder.noises.length);
    expect(cutRecorder.noises.some((noise) => noise.filter === 'bandpass')).toBe(true);
    expect(whiffRecorder.noises.some((noise) => noise.filter === 'bandpass')).toBe(false);
    expect(cutRecorder.voices.some((voice) => voice.filter === 'lowpass')).toBe(true);
    expect(whiffRecorder.voices).toHaveLength(0);
  });

  it('puts a sub under everything that is meant to be felt', async () => {
    // The layer the mix had none of. Without it a hit can only get louder, never
    // heavier, which is the whole difference this pass was aimed at.
    for (const event of [
      at('shot', { sourceEntityId: 1 }),
      at('kill', { targetEntityId: 7 }),
      at('melee', { targetEntityId: 7 }),
      at('death', { entityId: 1 }),
      at('gateOpen', { gateId: 'gate-one' }),
      at('hit', { targetEntityId: 1, value: 14 }),
    ]) {
      const recorder = recordingContext();
      const bus = await busWith(recorder);
      bus.consume([event], { position: [0, 0, 0], yaw: 0, playerId: 1 });
      const subs = recorder.voices.filter((voice) => voice.filter === 'lowpass');
      expect(subs.length, `${(event as { kind: string }).kind} should carry a sub`).toBeGreaterThan(0);
      // Under 200 Hz, or it is not a sub.
      expect(Math.min(...subs.map((voice) => voice.frequency))).toBeLessThan(200);
    }
  });

  it('does not put a sub under a shot the shield ate', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.consume([at('hit', { targetEntityId: 7, value: 11, deflected: true })]);
    // The cue is a flat clank on purpose: the player connected and it did not count,
    // so it must not carry the weight a real hit does.
    expect(recorder.voices.filter((voice) => voice.filter === 'lowpass')).toHaveLength(0);
  });

  it('gives the heavy more weight than the light, and the whiff more length', async () => {
    const swing = async (extra: Record<string, unknown>) => {
      const recorder = recordingContext();
      const bus = await busWith(recorder);
      bus.consume([{ id: 5, tick: 1, kind: 'melee', sourceEntityId: 1, ...extra } as never]);
      return recorder;
    };
    const light = await swing({ targetEntityId: 7 });
    const heavy = await swing({ targetEntityId: 7, heavy: true });

    // Two subs an octave apart where the light has one, and a louder one -- the same
    // trick the kill uses, because a heavy landing on three hostiles moved the room.
    const subs = (recorder: { voices: { filter: string | null; type: string; gain: number }[] }) =>
      recorder.voices.filter((voice) => voice.filter === 'lowpass' && voice.type === 'sine');
    expect(subs(heavy).length).toBeGreaterThan(subs(light).length);
    expect(Math.max(...subs(heavy).map((voice) => voice.gain))).toBeGreaterThan(Math.max(...subs(light).map((voice) => voice.gain)));

    // And a heavy that cut air says how much was just committed.
    const lightWhiff = await swing({});
    const heavyWhiff = await swing({ heavy: true });
    expect(heavyWhiff.noises[0].cutoff).toBeLessThan(lightWhiff.noises[0].cutoff);
  });

  it('sends a distant event further into the room than a near one', async () => {
    const listener = { position: [0, 0, 0] as const, yaw: 0, playerId: 1 };
    const near = recordingContext();
    const nearBus = await busWith(near);
    nearBus.consume([at('enemyAttack', { sourceEntityId: 2, targetEntityId: 1, value: 0, position: [0, 0, -4], origin: [0, 0, -4] })], listener);

    const far = recordingContext();
    const farBus = await busWith(far);
    farBus.consume([at('enemyAttack', { sourceEntityId: 2, targetEntityId: 1, value: 0, position: [0, 0, -40], origin: [0, 0, -40] })], listener);

    // Depth comes from wetness, not only from level: something forty metres away
    // arrives mostly as its own reflections.
    expect(near.sends).toContain('wetNear');
    expect(far.sends).toContain('wetFar');
    expect(far.sends).not.toContain('wetNear');
  });

  it('keeps the player\'s own weapon dry', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.consume([at('shot', { sourceEntityId: 1 })], { position: [0, 0, 0], yaw: 0, playerId: 1 });
    // It is in their hands, so it has no room around it -- and it is the one sound
    // that must never be softened by anything.
    expect(recorder.sends.filter((send) => send === 'wetFar')).toHaveLength(0);
  });

  it('varies a repeated shot without ever varying the same shot', async () => {
    const pitchesFor = async (id: number): Promise<number[]> => {
      const recorder = recordingContext();
      const bus = await busWith(recorder);
      bus.consume([{ id, tick: 1, kind: 'shot', sourceEntityId: 1 }]);
      return recorder.voices.map((voice) => voice.frequency);
    };
    const first = await pitchesFor(1);
    const second = await pitchesFor(2);
    // A held trigger must not be the identical waveform over and over.
    expect(first).not.toEqual(second);
    // But the variation is hashed from the event id, not rolled, so the same shot
    // sounds the same way every time it is replayed.
    expect(await pitchesFor(1)).toEqual(first);
  });
});

describe('the bed under the run', () => {
  const at = (speed: number, threat: number, down = false, links = 0) =>
    ({ speed, threat, down, space: 0.15, chain: { links, window: links > 0 ? 1 : 0 } });

  it('says nothing until the run asks for it', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    // The menu shares this class and never calls `sustain`. A drone under a main menu is
    // a drone the player mutes before they ever reach a fight.
    for (const kind of ['hover', 'select', 'confirm'] as const) bus.cue(kind);
    expect(recorder.bedAutomation).toHaveLength(0);
  });

  it('holds a floor up between fights and a heavier one in a room', async () => {
    const levels = async (threat: number): Promise<number> => {
      const recorder = recordingContext();
      const bus = await busWith(recorder);
      bus.sustain(at(0, threat));
      const floor = recorder.bedAutomation.filter((entry) => entry.node === 'floor');
      expect(floor).toHaveLength(1);
      return floor[0].value;
    };
    const corridor = await levels(0);
    const room = await levels(5);
    // There *is* a floor with nothing happening -- that is the point of a bed -- and a
    // live room weighs more than a corridor.
    expect(corridor).toBeGreaterThan(0);
    expect(room).toBeGreaterThan(corridor * 1.8);
  });

  it('opens the movement layer with speed, and closes it at a standstill', async () => {
    const drive = async (speed: number) => {
      const recorder = recordingContext();
      const bus = await busWith(recorder);
      bus.sustain(at(speed, 0));
      return {
        gain: recorder.bedAutomation.filter((entry) => entry.node === 'drive').at(-1)?.value ?? -1,
        cutoff: Math.max(...recorder.filterCutoffs.flat()),
      };
    };
    const still = await drive(0);
    const walking = await drive(7);
    const flying = await drive(24);
    // Silent standing, and it both rises and brightens as the player accelerates: the
    // renderer has widened the frame with speed since AUDIT.md section 3.3 and the mix
    // said nothing at all.
    expect(still.gain).toBe(0);
    expect(walking.gain).toBeGreaterThan(0);
    expect(flying.gain).toBeGreaterThan(walking.gain);
    expect(flying.cutoff).toBeGreaterThan(walking.cutoff);
  });

  it('drops the floor out from under a downed player', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.sustain(at(18, 5, true));
    // Not a quieter version of being alive. The floor going out is the loudest thing
    // about dying, and the death cue's own duck lands in the hole it leaves.
    for (const entry of recorder.bedAutomation) expect(entry.value).toBe(0);
  });

  it('sits under every transient in the mix', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.sustain(at(24, 5));
    const loudest = Math.max(...recorder.bedAutomation.map((entry) => entry.value));

    const shotRecorder = recordingContext();
    const shotBus = await busWith(shotRecorder);
    shotBus.consume([{ id: 1, tick: 1, kind: 'shot', sourceEntityId: 1 }]);
    const shot = Math.max(...shotRecorder.voices.map((voice) => voice.gain), ...shotRecorder.noises.map((noise) => noise.gain));
    // A bed you notice is a bed you turn off.
    expect(loudest).toBeLessThan(shot);
  });

  it('runs through the bus, so a duck takes the floor with it', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.sustain(at(20, 4));
    bus.consume([{ id: 1, tick: 1, kind: 'kill', targetEntityId: 7 }]);
    // The whole reason the bed exists: the duck had nothing sounding to remove, so the
    // return -- which is the effect -- had nothing to return from. Both layers are
    // connected to the bus the duck automates rather than past it.
    expect(recorder.sends.filter((send) => send === 'bus').length).toBeGreaterThan(0);
    expect(recorder.ducks.length).toBeGreaterThan(0);
    expect(Math.min(...recorder.ducks.map((duck) => duck.value))).toBeLessThan(recorder.ducks[0].value);
  });
});

describe('the mix pays the player for aggression', () => {
  it('rises where damage taken falls, and never as loudly', async () => {
    const healed = recordingContext();
    const healBus = await busWith(healed);
    healBus.consume([{ id: 1, tick: 1, kind: 'heal', entityId: 1, value: 18 }], listener);

    const hurt = recordingContext();
    const hurtBus = await busWith(hurt);
    hurtBus.consume([{ id: 1, tick: 1, kind: 'hit', targetEntityId: 1, value: 22 }], listener);

    // The direction is the whole cue: a heal is the only thing in the mix that gives
    // something back, so it rises, and it sits on the fifth the bed is built from where
    // damage taken sits on the flat second that beats against it.
    expect(healed.voices.length).toBeGreaterThan(0);
    expect(Math.max(...healed.voices.map((voice) => voice.gain)))
      .toBeLessThan(Math.max(...hurt.voices.map((voice) => voice.gain)));
    // And it does not duck. The kill that caused it ducked on the same tick, and two
    // punctuation marks on one event is pumping rather than emphasis.
    expect(healed.ducks).toHaveLength(0);
  });

  it('gets louder with the size of the heal, without leaving the floor of the mix', async () => {
    const level = async (amount: number) => {
      const recorder = recordingContext();
      const bus = await busWith(recorder);
      bus.consume([{ id: 1, tick: 1, kind: 'heal', entityId: 1, value: amount }], listener);
      return Math.max(...recorder.voices.map((voice) => voice.gain));
    };
    const small = await level(6);
    const large = await level(18);
    expect(large).toBeGreaterThan(small);
    // A cue that pays the player must not be the loudest thing they hear.
    const kill = recordingContext();
    const killBus = await busWith(kill);
    killBus.consume([{ id: 2, tick: 1, kind: 'kill', targetEntityId: 7 }], listener);
    expect(large).toBeLessThan(Math.max(...kill.voices.map((voice) => voice.gain)));
  });
});

describe("the player's own level", () => {
  it('applies a level set before a gesture ever opened the context', async () => {
    const recorder = recordingContext();
    vi.stubGlobal('AudioContext', function AudioContextStub(this: unknown) { return recorder.context; } as unknown as typeof AudioContext);
    const bus = new AudioManager();
    // Every page starts here: the save is read long before a click is legally allowed
    // to start an `AudioContext`, so the level has to survive the wait.
    bus.setVolume(0.35);
    await bus.resume();
    expect(recorder.volumes.at(-1) ?? 1).toBeCloseTo(0.35, 6);
  });

  it('clamps what it is handed, and mutes at zero', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.setVolume(4);
    expect(recorder.volumes.at(-1)).toBe(1);
    bus.setVolume(-1);
    expect(recorder.volumes.at(-1)).toBe(0);
  });

  it('keeps the duck off the volume node, and the volume out of the duck', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.setVolume(0.4);
    const beforeKill = recorder.volumes.length;
    bus.consume([{ id: 1, tick: 1, kind: 'kill', targetEntityId: 7 }]);
    // Two separate nodes on purpose. The duck writes absolute values to the bus, so a
    // volume applied there would be overwritten by the next kill -- and a duck that
    // had to fold the player's level into every ramp is a duck that gets it wrong once.
    expect(recorder.volumes).toHaveLength(beforeKill);
    expect(recorder.ducks.at(-1)?.value).toBeCloseTo(recorder.ducks[0].value, 6);
  });
});

/**
 * One of every cue the run can play, with the fields each one reads. This is the guard on
 * the thing the register pass was about -- it is easy to add a cue, and just as easy to
 * reach for a 900 Hz square while doing it -- and the key pass reads the same list, for
 * the same reason.
 */
const runCues: readonly GameEvent[] = [
  { id: 1, tick: 1, kind: 'shot', sourceEntityId: 1 },
  { id: 2, tick: 1, kind: 'dryFire', sourceEntityId: 1 },
  { id: 3, tick: 1, kind: 'impact', sourceEntityId: 1, position: [0, 0, -6] },
  { id: 4, tick: 1, kind: 'hit', targetEntityId: 7, value: 34 },
  { id: 5, tick: 1, kind: 'hit', targetEntityId: 7, value: 60, headshot: true },
  { id: 6, tick: 1, kind: 'hit', targetEntityId: 7, value: 11, deflected: true },
  { id: 7, tick: 1, kind: 'hit', targetEntityId: 1, value: 14 },
  { id: 8, tick: 1, kind: 'kill', targetEntityId: 7 },
  { id: 31, tick: 1, kind: 'heal', entityId: 1, value: 12 },
  { id: 9, tick: 1, kind: 'melee', sourceEntityId: 1 },
  { id: 10, tick: 1, kind: 'melee', sourceEntityId: 1, targetEntityId: 7 },
  { id: 28, tick: 1, kind: 'melee', sourceEntityId: 1, value: 0, heavy: true },
  { id: 29, tick: 1, kind: 'melee', sourceEntityId: 1, targetEntityId: 7, value: 3, heavy: true },
  { id: 11, tick: 1, kind: 'enemyTelegraph', sourceEntityId: 2, targetEntityId: 1, value: 0.42 },
  { id: 12, tick: 1, kind: 'enemyAttack', sourceEntityId: 2, targetEntityId: 1, value: 10 },
  { id: 13, tick: 1, kind: 'death', entityId: 1 },
  { id: 14, tick: 1, kind: 'respawn', entityId: 1 },
  { id: 15, tick: 1, kind: 'comboLink', value: 6 },
  { id: 16, tick: 1, kind: 'comboBreak', value: 6 },
  { id: 17, tick: 1, kind: 'dodge', targetEntityId: 1, value: 10 },
  { id: 18, tick: 1, kind: 'split', value: 30 },
  { id: 19, tick: 1, kind: 'reloadStart' },
  { id: 20, tick: 1, kind: 'reloadComplete' },
  { id: 21, tick: 1, kind: 'checkpoint' },
  { id: 22, tick: 1, kind: 'complete' },
  { id: 23, tick: 1, kind: 'gateOpen', gateId: 'gate-one' },
  { id: 30, tick: 1, kind: 'wave', value: 2 },
  { id: 24, tick: 1, kind: 'grappleAttach' },
  { id: 25, tick: 1, kind: 'grapplePull' },
  { id: 26, tick: 1, kind: 'grappleRelease' },
  { id: 27, tick: 1, kind: 'grappleFail' },
];

const listener = { position: [0, 0, 0] as const, yaw: 0, playerId: 1 };

describe('the register itself', () => {
  it('has no tonal layer anywhere near the beep register', async () => {
    for (const event of runCues) {
      const recorder = recordingContext();
      const bus = await busWith(recorder);
      bus.consume([event], listener);
      for (const voice of recorder.voices) {
        // 200 Hz is roughly G3. Everything the run plays starts at or below it, which
        // is an octave and a half under where this mix used to sit.
        expect(voice.frequency, `${event.kind} plays a ${Math.round(voice.frequency)} Hz voice`).toBeLessThanOrEqual(200);
      }
    }
  });

  it('keeps every high-frequency layer short and quiet enough to be an edge', async () => {
    for (const event of runCues) {
      const recorder = recordingContext();
      const bus = await busWith(recorder);
      bus.consume([event], listener);
      for (const noise of recorder.noises.filter((entry) => entry.cutoff > 1000)) {
        // Definition, not content. Past this it stops being a transient and starts
        // being the thing the pass removed.
        expect(noise.gain, `${event.kind} has a loud high layer`).toBeLessThanOrEqual(0.045);
        expect(noise.filter, `${event.kind} has an unbanded high layer`).toBe('bandpass');
      }
    }
  });

  it('puts weight under every cue that is meant to land, and none under the ones that are not', async () => {
    // A driven sub is what makes a hit heavy rather than loud, so anything the player is
    // supposed to feel has one. The exceptions are deliberate and each is a statement:
    // a surface tick is debris, a deflected round is dead, a whiff is air, and a
    // magazine coming out is mechanism rather than impact.
    const weightless = new Set(['impact', 'dryFire', 'grappleFail', 'reloadStart']);
    for (const event of runCues) {
      const recorder = recordingContext();
      const bus = await busWith(recorder);
      bus.consume([event], listener);
      const subs = recorder.voices.filter((voice) => voice.filter === 'lowpass' && voice.type === 'sine');
      const deliberatelyDry = weightless.has(event.kind)
        || (event.kind === 'hit' && event.deflected === true)
        || (event.kind === 'melee' && event.targetEntityId === undefined);
      if (deliberatelyDry) expect(subs, `${event.kind} should carry no sub`).toHaveLength(0);
      else expect(subs.length, `${event.kind} should carry a sub`).toBeGreaterThan(0);
    }
  });
});

describe('the mix is in one key', () => {
  /**
   * Whether a pitch is a degree of the key, in any octave, allowing the detune the
   * per-event variation applies. The tolerance is 3 per cent where the detune is 2 and
   * the smallest interval in the table is 6.7, so this cannot pass by landing on the
   * neighbouring degree.
   */
  const inKey = (frequency: number): boolean => Object.values(mixKey.intervals).some((ratio) => {
    const octaves = Math.log2(frequency / (mixKey.rootHz * ratio));
    return Math.abs(octaves - Math.round(octaves)) < 0.032;
  });

  it('knows its own root', () => {
    // A guard on the guard: 34 Hz and its fifth are in the key, and the pitch halfway
    // between two degrees is not -- otherwise `inKey` would pass anything.
    expect(inKey(mixKey.rootHz)).toBe(true);
    expect(inKey(mixKey.rootHz * 1.5)).toBe(true);
    expect(inKey(mixKey.rootHz * 1.13)).toBe(false);
  });

  it('derives every tonal layer the run plays from an interval over the root', async () => {
    // This is the change job 1 turned on, and it is the only way to hold it: a hundred
    // pitches in one file, each of which used to be a number that sounded right alone.
    // A kill at 104 Hz over a chain tone at 68 is a minor sixth *and a bit*, and the bit
    // is what the ear hears when two cues land together.
    for (const event of runCues) {
      const recorder = recordingContext();
      const bus = await busWith(recorder);
      bus.consume([event], listener);
      for (const voice of recorder.voices) {
        expect(inKey(voice.frequency), `${event.kind} plays ${voice.frequency.toFixed(1)} Hz, which is not in the key`).toBe(true);
      }
    }
  });

  it('puts the interface in the same key, two octaves up where it lives', async () => {
    for (const kind of ['hover', 'select', 'confirm', 'cancel', 'result'] as const) {
      const recorder = recordingContext();
      const bus = await busWith(recorder);
      bus.cue(kind);
      for (const voice of recorder.voices) {
        expect(inKey(voice.frequency), `${kind} plays ${voice.frequency.toFixed(1)} Hz`).toBe(true);
      }
    }
  });

  it('keeps a repeated cue varied without letting it leave the key', async () => {
    // The variation is what stops a held trigger being one identical waveform, and at
    // the spread the noise layers use it would put a sub 93 cents off -- most of a
    // semitone, and wider than the smallest interval in the table.
    const pitches = new Set<number>();
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const recorder = recordingContext();
      const bus = await busWith(recorder);
      bus.consume([{ id, tick: 1, kind: 'shot', sourceEntityId: 1 }]);
      for (const voice of recorder.voices) {
        pitches.add(voice.frequency);
        expect(inKey(voice.frequency)).toBe(true);
      }
    }
    expect(pitches.size).toBeGreaterThan(8);
  });
});

describe('a live chain drives the mix', () => {
  const bed = (links: number) => ({ speed: 8, threat: 3, down: false, space: 0.15, chain: { links, window: 1 } });

  it('opens the floor, the colour note and the room as the chain grows', async () => {
    const state = async (links: number) => {
      const recorder = recordingContext();
      const bus = await busWith(recorder);
      bus.sustain(bed(links));
      return {
        floor: recorder.bedAutomation.filter((entry) => entry.node === 'floor').at(-1)?.value ?? 0,
        harmonic: recorder.bedAutomation.filter((entry) => entry.node === 'harmonic').at(-1)?.value ?? -1,
        send: recorder.sendAutomation.filter((entry) => entry.node === 'wetFar').at(-1)?.value ?? 0,
        cutoff: Math.max(...recorder.filterCutoffs.flat()),
      };
    };
    const cold = await state(0);
    const warm = await state(4);
    const live = await state(9);

    // The chain is the game's measure of playing well and the mix said one thing about
    // it: a tone per link. A chain being live is now a state of the room.
    expect(cold.harmonic).toBe(0);
    expect(warm.harmonic).toBeGreaterThan(0);
    expect(live.harmonic).toBeGreaterThan(warm.harmonic);
    expect(live.floor).toBeGreaterThan(cold.floor);
    expect(live.send).toBeGreaterThan(cold.send);
    expect(live.cutoff).toBeGreaterThan(cold.cutoff);
    // And it saturates rather than climbing forever: past the S-rank gate there is
    // nothing left to open, which is what stops a long chain becoming a siren.
    const past = await state(20);
    expect(past.harmonic).toBeCloseTo(live.harmonic, 6);
  });

  it('transposes the whole floor rather than growing a note on top of it', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.sustain(bed(9));
    // Both held oscillators move, by the same ratio, so the bed changes key instead of
    // becoming a chord it was not designed as. A held oscillator cannot be restarted, so
    // moving the two it already has is also the only option available.
    const moved = recorder.pitchTargets.filter((target) => target.to !== target.from);
    expect(moved.length).toBeGreaterThanOrEqual(2);
    const ratios = moved.map((target) => target.to / target.from);
    for (const ratio of ratios) {
      expect(ratio).toBeGreaterThan(1);
      expect(ratio).toBeCloseTo(ratios[0], 6);
    }
    // And it is a degree of the key, not an arbitrary glide.
    expect(ratios[0]).toBeCloseTo(mixKey.intervals.fifth, 6);
  });

  it('fades the colour note as the chain runs out of window', async () => {
    const harmonic = async (window: number) => {
      const recorder = recordingContext();
      const bus = await busWith(recorder);
      bus.sustain({ speed: 8, threat: 3, down: false, space: 0.15, chain: { links: 8, window } });
      return recorder.bedAutomation.filter((entry) => entry.node === 'harmonic').at(-1)?.value ?? -1;
    };
    const open = await harmonic(1);
    const closing = await harmonic(0.2);
    const gone = await harmonic(0);
    // A chain about to lapse is audible as the thing the player is about to lose dimming,
    // rather than as a warning arriving on top of the fight. The threshold is the same
    // 0.34 the HUD's combo readout calls `lapsing`.
    expect(closing).toBeLessThan(open);
    expect(gone).toBe(0);
    // And the floor it climbed to does not fade with it: losing the chain is what takes
    // that away, so the drop is what lands.
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.sustain({ speed: 8, threat: 3, down: false, space: 0.15, chain: { links: 8, window: 0.05 } });
    const floor = recorder.bedAutomation.filter((entry) => entry.node === 'floor').at(-1)?.value ?? 0;
    const cold = recordingContext();
    const coldBus = await busWith(cold);
    coldBus.sustain({ speed: 8, threat: 3, down: false, space: 0.15, chain: { links: 0, window: 0 } });
    expect(floor).toBeGreaterThan(cold.bedAutomation.filter((entry) => entry.node === 'floor').at(-1)!.value);
  });

  it('says nothing new per frame, however long the chain is', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    for (let frame = 0; frame < 30; frame += 1) bus.sustain(bed(12));
    // The lesson `comboScoring.flourishFromLink` records, in sound: an effect that fires
    // every frame is decoration, and a *sound* that does is worse because the player
    // cannot look away from it. Everything here is a smoothed target on a node that
    // already exists.
    expect(recorder.voices).toHaveLength(0);
    expect(recorder.noises).toHaveLength(0);
    expect(recorder.ducks).toHaveLength(0);
  });

  it('climbs the scale a degree per link, and stops climbing before it gets shrill', async () => {
    const link = async (links: number) => {
      const recorder = recordingContext();
      const bus = await busWith(recorder);
      bus.consume([{ id: 1, tick: 1, kind: 'comboLink', value: links }]);
      return recorder.voices[0].frequency;
    };
    const first = await link(1);
    const fourth = await link(4);
    const eighth = await link(8);
    expect(fourth).toBeGreaterThan(first);
    expect(eighth).toBeGreaterThan(fourth);
    // A chain of twenty is reachable, and a scale that kept climbing would put the style
    // meter back in the beep register a whole pass was spent leaving.
    expect(await link(20)).toBeLessThanOrEqual(200);
  });
});

describe('a cue knows what it hit', () => {
  const roster = (kind: 'ranged' | 'aggressive' | 'bulwark') =>
    ({ position: [0, 0, 0] as const, yaw: 0, playerId: 1, roster: new Map([[7, { kind, position: [0, 0, 0] as const, facing: 0 }]]) });
  const slash = async (kind: 'ranged' | 'aggressive' | 'bulwark', extra: Record<string, unknown> = {}) => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.consume([{ id: 3, tick: 1, kind: 'melee', sourceEntityId: 1, targetEntityId: 7, ...extra } as never], roster(kind));
    return recorder;
  };

  it('rings a plate, and gives it none of the weight a body gets', async () => {
    const plate = await slash('bulwark', { deflected: false });
    const flesh = await slash('aggressive');
    // The simulation has treated these as three different problems since the bulwark was
    // authored -- a plate is a puzzle, a brawler is proximity -- and the mix knew about
    // exactly one of them, through `deflected`.
    expect(flesh.noises.some((noise) => noise.filter === 'lowpass' && noise.cutoff < 200)).toBe(true);
    expect(plate.noises.some((noise) => noise.cutoff > 240)).toBe(true);
  });

  it('takes the weight off a slash the guard ate and leaves the plate ringing', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.consume([
      { id: 3, tick: 1, kind: 'melee', sourceEntityId: 1, targetEntityId: 7 },
      { id: 4, tick: 1, kind: 'hit', sourceEntityId: 1, targetEntityId: 7, value: 12, deflected: true },
    ], roster('bulwark'));
    // A cut that did not count carries no sub, exactly as a deflected round does not --
    // and what is left is the plate, which is the thing to get around.
    expect(recorder.voices.filter((voice) => voice.filter === 'lowpass')).toHaveLength(0);
    expect(recorder.noises.filter((noise) => noise.filter === 'bandpass').length).toBeGreaterThan(1);
  });

  it('makes a brawler at arm\'s length denser than a hunter at range', async () => {
    const brawler = await slash('aggressive');
    const hunter = await slash('ranged');
    const weight = (recorder: { voices: { filter: string | null; gain: number }[] }) =>
      Math.max(...recorder.voices.filter((voice) => voice.filter === 'lowpass').map((voice) => voice.gain));
    expect(weight(brawler)).toBeGreaterThan(weight(hunter));
  });

  it('plays one impact for a killing slash where it used to play three', async () => {
    const killing = recordingContext();
    const killingBus = await busWith(killing);
    // Exactly what one tick of `FlowSimulation.swing` emits when the blade finishes a
    // hunter: the swing, the damage and the death, in that order.
    killingBus.consume([
      { id: 1, tick: 1, kind: 'melee', sourceEntityId: 1, targetEntityId: 7, value: 1 },
      { id: 2, tick: 1, kind: 'hit', sourceEntityId: 1, targetEntityId: 7, value: 65 },
      { id: 3, tick: 1, kind: 'kill', targetEntityId: 7, value: 100 },
    ], roster('ranged'));

    const separate = recordingContext();
    const separateBus = await busWith(separate);
    separateBus.consume([{ id: 2, tick: 1, kind: 'hit', sourceEntityId: 1, targetEntityId: 7, value: 65 }], roster('ranged'));
    const alone = recordingContext();
    const aloneBus = await busWith(alone);
    aloneBus.consume([{ id: 3, tick: 1, kind: 'kill', targetEntityId: 7, value: 100 }], roster('ranged'));
    const cut = recordingContext();
    const cutBus = await busWith(cut);
    cutBus.consume([{ id: 1, tick: 1, kind: 'melee', sourceEntityId: 1, targetEntityId: 7, value: 1 }], roster('ranged'));

    const layers = (recorder: { voices: unknown[]; noises: unknown[] }) => recorder.voices.length + recorder.noises.length;
    // The confirm stands down: what the player hears is the cut and the kill combined,
    // not three cues queueing behind each other on one attack.
    expect(layers(killing)).toBeLessThan(layers(separate) + layers(alone) + layers(cut));
    expect(layers(killing)).toBeGreaterThan(layers(alone));
    // And the kill still ducks, because it is still the biggest moment in the loop.
    expect(killing.ducks.length).toBeGreaterThan(0);
  });

  it('answers a second body on the same tick instead of repeating the first', async () => {
    const single = recordingContext();
    const singleBus = await busWith(single);
    singleBus.consume([{ id: 1, tick: 1, kind: 'kill', targetEntityId: 7 }], roster('ranged'));

    const sweep = recordingContext();
    const sweepBus = await busWith(sweep);
    // What a heavy landing on three hostiles emits: one swing and three deaths, on one
    // tick. It is ordinary play, not an edge case.
    sweepBus.consume([
      { id: 1, tick: 1, kind: 'melee', sourceEntityId: 1, targetEntityId: 7, heavy: true },
      { id: 2, tick: 1, kind: 'kill', targetEntityId: 7 },
      { id: 3, tick: 1, kind: 'kill', targetEntityId: 8 },
      { id: 4, tick: 1, kind: 'kill', targetEntityId: 9 },
    ], roster('ranged'));

    const layers = (recorder: { voices: unknown[]; noises: unknown[] }) => recorder.voices.length + recorder.noises.length;
    // Three copies of one cue at one pitch is not a bigger sound, it is the same waveform
    // nine decibels louder -- so the second answers a fourth up and the third is not
    // played at all.
    expect(layers(sweep)).toBeLessThan(layers(single) * 3);
    const pitches = new Set(sweep.voices.map((voice) => Math.round(voice.frequency)));
    expect(pitches.size).toBeGreaterThan(2);
    // And one duck, not three: overlapping ducks are pumping.
    const attacks = sweep.ducks.filter((duck) => duck.at === 0);
    expect(attacks.length).toBeLessThanOrEqual(2);
  });

  it('carries the blade that did it into the kill, so a cut kill is not a shot kill', async () => {
    const byBlade = recordingContext();
    const bladeBus = await busWith(byBlade);
    bladeBus.consume([
      { id: 1, tick: 1, kind: 'melee', sourceEntityId: 1, targetEntityId: 7 },
      { id: 2, tick: 1, kind: 'kill', targetEntityId: 7 },
    ], roster('ranged'));

    const byRound = recordingContext();
    const roundBus = await busWith(byRound);
    roundBus.consume([{ id: 2, tick: 1, kind: 'kill', targetEntityId: 7 }], roster('ranged'));

    // The transient is the killing blow's own, so the two read as different attacks
    // rather than as the same kill with a different thing in front of it.
    const edges = (recorder: { noises: { filter: string; cutoff: number }[] }) =>
      recorder.noises.filter((noise) => noise.filter === 'bandpass').map((noise) => noise.cutoff);
    expect(edges(byBlade)[0]).not.toBeCloseTo(edges(byRound)[0], 1);
    expect(Math.min(...byBlade.ducks.map((duck) => duck.value)))
      .toBeLessThan(Math.min(...byRound.ducks.map((duck) => duck.value)));
  });
});

describe('the three blades sound like themselves', () => {
  const cut = async (style: 'tempo' | 'cleave' | 'riposte', extra: Record<string, unknown> = {}) => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.setBladeStyle(style);
    bus.consume([{ id: 9, tick: 1, kind: 'melee', sourceEntityId: 1, targetEntityId: 7, ...extra } as never]);
    const subs = recorder.voices.map((voice, index) => ({ ...voice, duration: recorder.durations[index] ?? 0 }))
      .filter((voice) => voice.filter === 'lowpass' && voice.type === 'sine');
    return {
      hz: Math.min(...subs.map((voice) => voice.frequency)),
      seconds: Math.max(...subs.map((voice) => voice.duration)),
      gain: Math.max(...subs.map((voice) => voice.gain)),
      edge: Math.max(...recorder.noises.filter((noise) => noise.filter === 'bandpass').map((noise) => noise.cutoff)),
      voices: recorder.voices,
    };
  };

  it('is lower, longer and heavier on Cleave and quicker and brighter on Riposte', async () => {
    const tempo = await cut('tempo');
    const cleave = await cut('cleave');
    const riposte = await cut('riposte');
    // The three styles differ in reach, recovery and chain rules and sounded identical,
    // which made the one choice the player makes about the primary verb inaudible. These
    // are the only three terms a synthesised impact has.
    expect(cleave.hz).toBeLessThan(tempo.hz);
    expect(riposte.hz).toBeGreaterThan(tempo.hz);
    expect(cleave.seconds).toBeGreaterThan(tempo.seconds);
    expect(riposte.seconds).toBeLessThan(tempo.seconds);
    expect(cleave.gain).toBeGreaterThan(tempo.gain);
    expect(riposte.gain).toBeLessThan(tempo.gain);
    expect(cleave.edge).toBeLessThan(tempo.edge);
    expect(riposte.edge).toBeGreaterThan(tempo.edge);
  });

  it('keeps every style in the register and inside the key', async () => {
    for (const style of ['tempo', 'cleave', 'riposte'] as const) {
      for (const swing of [{}, { heavy: true }]) {
        const recorder = recordingContext();
        const bus = await busWith(recorder);
        bus.setBladeStyle(style);
        bus.consume([{ id: 9, tick: 1, kind: 'melee', sourceEntityId: 1, targetEntityId: 7, ...swing } as never]);
        for (const voice of recorder.voices) {
          // Whatever a style is allowed to do to the blade, it may not undo the register
          // pass or leave the key -- the same rule `content/blades.ts` states about reach.
          expect(voice.frequency, `${style} plays ${voice.frequency.toFixed(1)} Hz`).toBeLessThanOrEqual(200);
        }
      }
    }
  });

  it('keeps the heavy heavier than the light on every style', async () => {
    for (const style of ['tempo', 'cleave', 'riposte'] as const) {
      const light = await cut(style);
      const heavy = await cut(style, { heavy: true });
      expect(heavy.gain, style).toBeGreaterThan(light.gain);
      expect(heavy.seconds, style).toBeGreaterThan(light.seconds);
      expect(heavy.hz, style).toBeLessThan(light.hz);
    }
  });

  it('says how much a whiff committed, per style', async () => {
    const air = async (style: 'tempo' | 'cleave' | 'riposte', heavy: boolean) => {
      const recorder = recordingContext();
      const bus = await busWith(recorder);
      bus.setBladeStyle(style);
      bus.consume([{ id: 9, tick: 1, kind: 'melee', sourceEntityId: 1, heavy } as never]);
      return recorder.noises[0];
    };
    // A whiff is dark air and nothing else, and how much air is the statement: a heavy
    // is longer and lower than a light one, and Cleave's says more than Riposte's.
    expect((await air('cleave', false)).cutoff).toBeLessThan((await air('riposte', false)).cutoff);
    expect((await air('tempo', true)).cutoff).toBeLessThan((await air('tempo', false)).cutoff);
  });
});

describe('wiring the interface to the bus', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  function press(element: Element, type: string): void {
    element.dispatchEvent(new Event(type, { bubbles: true }));
  }

  it('acknowledges a control once per hover and on the press, and stops when disposed', () => {
    const cue = vi.spyOn(AudioManager.prototype, 'cue').mockImplementation(() => {});
    document.body.innerHTML = '<button class="primary">Start run</button><button disabled>Nope</button>';
    const [action, disabled] = [...document.querySelectorAll('button')];
    const dispose = installInterfaceAudio();

    press(action, 'pointerover');
    press(action, 'pointerover');
    // Entering the same control twice is one hover, not two.
    expect(cue.mock.calls.map(([kind]) => kind)).toEqual(['hover']);

    press(action, 'pointerdown');
    expect(cue.mock.calls.at(-1)?.[0]).toBe('confirm');

    // A disabled control is not a control.
    cue.mockClear();
    press(disabled, 'pointerover');
    press(disabled, 'pointerdown');
    expect(cue.mock.calls.map(([kind]) => kind)).toEqual([]);

    dispose();
    press(action, 'pointerout');
    press(action, 'pointerover');
    press(action, 'pointerdown');
    expect(cue).not.toHaveBeenCalled();
    cue.mockRestore();
  });

  it('says nothing for a press that is not on a control', () => {
    const cue = vi.spyOn(AudioManager.prototype, 'cue').mockImplementation(() => {});
    document.body.innerHTML = '<p>Some copy</p><input aria-label="Build name" />';
    const dispose = installInterfaceAudio();
    press(document.querySelector('p')!, 'pointerover');
    press(document.querySelector('input')!, 'pointerdown');
    expect(cue).not.toHaveBeenCalled();
    dispose();
    cue.mockRestore();
  });
});

describe('a cue lands when it happened, not when the frame did', () => {
  it('spreads a batch across the ticks it actually spans', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    // What one rendered frame owing four simulation steps hands the mix: two shots three
    // ticks apart. They used to be scheduled at the same instant, which is a cluster.
    bus.consume([
      { id: 1, tick: 120, kind: 'shot' },
      { id: 2, tick: 123, kind: 'shot' },
    ]);
    const starts = [...new Set(recorder.voices.map((voice) => voice.startAt))].sort((a, b) => a - b);
    expect(starts[0]).toBe(0);
    // Three steps of a fixed 1/60 s. Sample-accurate and deterministic, which is what
    // makes a burst read as a rhythm.
    expect(starts.at(-1)).toBeCloseTo(3 / 60, 6);
  });

  it('starts the first event of a batch immediately, whatever tick it carries', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.consume([{ id: 1, tick: 98_765, kind: 'shot' }]);
    expect(Math.min(...recorder.voices.map((voice) => voice.startAt))).toBe(0);
  });
});

describe('distance is a time and a filter, not only a level', () => {
  const listener = { position: [0, 0, 0] as const, yaw: 0, playerId: 1 };
  const gateAt = async (metres: number) => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.consume([{ id: 1, tick: 1, kind: 'gateOpen', position: [0, 0, -metres] }], listener);
    return recorder;
  };

  it('delays a distant event by its own flight time', async () => {
    const near = await gateAt(1);
    const far = await gateAt(40);
    const earliest = (recorder: { noises: { startAt: number }[] }) => Math.min(...recorder.noises.map((noise) => noise.startAt));
    // 343 m/s: a door forty metres down the route is 116 ms late, which is most of a beat
    // and the difference between "somewhere" and "over there".
    expect(earliest(far) - earliest(near)).toBeCloseTo(39 / 343, 3);
  });

  it('takes the top off a distant body', async () => {
    const near = await gateAt(1);
    const far = await gateAt(40);
    const cutoff = (recorder: { noises: { cutoff: number }[] }) => Math.max(...recorder.noises.map((noise) => noise.cutoff));
    // Air absorbs the top far faster than the bottom, so range is audible as darkness
    // rather than only as quiet.
    expect(cutoff(far)).toBeLessThan(cutoff(near) * 0.4);
  });

  it('leaves a cue in the player\'s own hands undelayed and unfiltered', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.consume([{ id: 1, tick: 1, kind: 'shot' }], listener);
    expect(recorder.noises.every((noise) => noise.startAt < 0.06)).toBe(true);
  });
});

describe('the window decides what is worth a voice', () => {
  const play = async (events: readonly GameEvent[]) => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.consume(events, { position: [0, 0, 0], yaw: 0, playerId: 1 });
    return recorder;
  };
  const kill: GameEvent = { id: 1, tick: 1, kind: 'kill', targetEntityId: 7 };
  const surface: GameEvent = { id: 2, tick: 1, kind: 'impact', position: [2, 0, -3] };
  const shot: GameEvent = { id: 3, tick: 1, kind: 'shot' };

  it('spends nothing on a surface tick under a kill, and plays the same tick under a shot', async () => {
    expect((await play([surface])).noises.length).toBeGreaterThan(0);
    // Counted against the same batch without it rather than matched by cutoff: a kill
    // carries a tick of its own within a couple of hundred hertz of this one, which is
    // most of the reason the window exists.
    expect((await play([kill, surface])).noises).toHaveLength((await play([kill])).noises.length);
    // And a round hitting a wall is worth hearing while the player is shooting at it.
    expect((await play([shot, surface])).noises.length).toBeGreaterThan((await play([shot])).noises.length);
  });

  it('never culls the one warning the player gets', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.consume([
      { id: 1, tick: 1, kind: 'kill', targetEntityId: 7 },
      { id: 2, tick: 1, kind: 'enemyTelegraph', position: [0, 0, -9], sourceEntityId: 8, value: 0.3 },
    ], { position: [0, 0, 0], yaw: 0, playerId: 1 });
    // The telegraph is quiet and it is the only thing standing between the player and
    // damage, so it is ranked far above what it is mixed at.
    expect(recorder.voices.some((voice) => voice.type === 'triangle')).toBe(true);
  });

  it('holds a shotgun pattern to two surface ticks', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.consume(
      Array.from({ length: 8 }, (_, index) => ({ id: index + 1, tick: 1, kind: 'impact' as const, position: [index, 0, -4] as const })),
      { position: [0, 0, 0], yaw: 0, playerId: 1 },
    );
    // Two layers each. Eight pellets is one shell, not eight events.
    expect(recorder.noises).toHaveLength(4);
  });
});

describe('the gun is a machine, and the bench is audible in it', () => {
  const shotWith = async (chassis: 'carbine' | 'smg' | 'shotgun' | 'dmr') => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.setWeaponChassis(chassis);
    bus.consume([{ id: 41, tick: 1, kind: 'shot' }]);
    return recorder;
  };

  it('throws a bolt after the shot rather than only with it', async () => {
    const recorder = await shotWith('carbine');
    // The mechanical layer: one click on the shot and one a bolt-throw later. Everything
    // else in the cue starts at zero.
    expect(recorder.noises.some((noise) => noise.startAt > 0.03 && noise.startAt < 0.1)).toBe(true);
  });

  it('gives a shotgun a slower, lower action than an SMG', async () => {
    const pump = await shotWith('shotgun');
    const smg = await shotWith('smg');
    const bolt = (recorder: { noises: { startAt: number; cutoff: number }[] }) =>
      recorder.noises.filter((noise) => noise.startAt > 0.02).sort((a, b) => b.startAt - a.startAt)[0];
    expect(bolt(pump).startAt).toBeGreaterThan(bolt(smg).startAt);
    expect(bolt(pump).cutoff).toBeLessThan(bolt(smg).cutoff);
  });

  it('makes an empty chamber the machine and nothing else', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.setWeaponChassis('dmr');
    bus.consume([{ id: 5, tick: 1, kind: 'dryFire' }]);
    // No sub anywhere: a dry trigger is the one shot cue with no round behind it.
    expect(recorder.voices).toHaveLength(0);
    expect(recorder.noises.some((noise) => noise.startAt > 0.03)).toBe(true);
  });
});

describe('the mix says which hostile is about to hurt you', () => {
  const telegraphFrom = async (facing: number) => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    const hostile = { kind: 'ranged' as const, position: [0, 0, -12] as const, facing };
    bus.consume(
      [{ id: 9, tick: 1, kind: 'enemyTelegraph', position: [0, 0, -12], sourceEntityId: 4, value: 0.3 }],
      { position: [0, 0, 0], yaw: 0, playerId: 1, roster: new Map([[4, hostile]]) },
    );
    return Math.max(...recorder.voices.map((voice) => voice.gain));
  };

  it('puts a hostile lined up on the player several decibels over one that is not', async () => {
    // Facing zero is the simulation's -Z; the player is at +Z from this bot, so a facing
    // of PI is pointed straight at them and zero is pointed away.
    const aimed = await telegraphFrom(Math.PI);
    const oblivious = await telegraphFrom(0);
    expect(aimed).toBeGreaterThan(oblivious);
    // About seven decibels, which is the gap Overwatch puts between its top threat
    // bucket and its third.
    const gap = 20 * Math.log10(aimed / oblivious);
    expect(gap).toBeGreaterThan(5);
    expect(gap).toBeLessThan(9);
  });

  it('reads intent from the hostile, so a roster-free caller is unchanged', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    expect(() => bus.consume(
      [{ id: 9, tick: 1, kind: 'enemyTelegraph', position: [0, 0, -12], sourceEntityId: 4, value: 0.3 }],
      { position: [0, 0, 0], yaw: 0, playerId: 1 },
    )).not.toThrow();
    expect(recorder.voices.length).toBeGreaterThan(0);
  });
});

describe('the pulse keeps time only while a room is live', () => {
  const depthAfter = async (threat: number, down = false) => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.sustain({ speed: 8, threat, down, space: 0.15, chain: { links: 0, window: 0 } });
    return recorder.bedAutomation.filter((entry) => entry.node === 'pulseDepth').at(-1)?.value ?? 0;
  };

  it('opens with the hostiles that can still act', async () => {
    expect(await depthAfter(0)).toBe(0);
    expect(await depthAfter(4)).toBeGreaterThan(0);
    expect(await depthAfter(4)).toBeGreaterThan(await depthAfter(1));
  });

  it('stops when the room is cleared, because a pulse you notice is a pulse you mute', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.sustain({ speed: 8, threat: 5, down: false, space: 0.15, chain: { links: 0, window: 0 } });
    bus.sustain({ speed: 8, threat: 0, down: false, space: 0.15, chain: { links: 0, window: 0 } });
    expect(recorder.bedAutomation.filter((entry) => entry.node === 'pulseDepth').at(-1)?.value).toBe(0);
  });

  it('goes with the floor when the player goes down', async () => {
    expect(await depthAfter(5, true)).toBe(0);
  });

  it('stays well under the quietest transient in the mix', async () => {
    // The bed's own rule: a floor you notice is a floor the player turns off, and the
    // pulse is the most noticeable thing that can be put in one.
    expect(await depthAfter(5)).toBeLessThan(0.03);
  });
});

describe('the blade does not sound like one recording', () => {
  const swing = async (count: number) => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    for (let index = 0; index < count; index += 1) {
      bus.consume([{ id: 100 + index, tick: 1, kind: 'melee', sourceEntityId: 1, targetEntityId: 7 }]);
    }
    // The edge is the only bandpass in a melee cue; the body under it is a lowpass.
    return recorder.noises.filter((noise) => noise.filter === 'bandpass');
  };

  it('alternates two edges rather than repeating one', async () => {
    const [first, second, third] = await swing(3);
    // Two consecutive cuts are two different transients, and the third is the first
    // again: a round robin rather than a random walk, so a combination reads as a
    // pattern the player can learn.
    expect(Math.abs(second.cutoff - first.cutoff) / first.cutoff).toBeGreaterThan(0.12);
    // The third is the first again, bar the per-event detune the whole mix carries: a
    // round robin rather than a random walk, so a combination reads as a pattern.
    expect(Math.abs(third.cutoff - first.cutoff) / first.cutoff).toBeLessThan(0.08);
  });

  it('varies the two in length, which is what is audible at five milliseconds', async () => {
    const [first, second] = await swing(2);
    // Pitch is the least audible knob on a transient this short -- two per cent of
    // 1200 Hz is nothing. The pair differ in how long they ring by half again, which is
    // the knob the ear actually reads at this duration.
    expect(Math.max(first.seconds, second.seconds) / Math.min(first.seconds, second.seconds)).toBeGreaterThan(1.3);
    // And both stay inside the eight milliseconds the register rule allows a transient.
    for (const edge of [first, second]) expect(edge.seconds).toBeLessThan(0.01);
  });

  it('gives each blade its own pair, so the styles stay apart', async () => {
    const edges = async (style: 'tempo' | 'cleave' | 'riposte') => {
      const recorder = recordingContext();
      const bus = await busWith(recorder);
      bus.setBladeStyle(style);
      bus.consume([{ id: 3, tick: 1, kind: 'melee', sourceEntityId: 1, targetEntityId: 7 }]);
      return recorder.noises.filter((noise) => noise.filter === 'bandpass')[0].cutoff;
    };
    // Riposte is the quick, bright one and Cleave is the heavy, dark one; that ordering
    // is the same one `content/blades.ts` states in reach and recovery.
    expect(await edges('riposte')).toBeGreaterThan(await edges('tempo'));
    expect(await edges('tempo')).toBeGreaterThan(await edges('cleave'));
  });
});

describe('the tail says which room a sound happened in', () => {
  const rooms = async (space: number) => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.sustain({ speed: 4, threat: 1, down: false, space, chain: { links: 0, window: 0 } });
    const at = (node: string) => recorder.sendAutomation.filter((entry) => entry.node === node).at(-1)?.value ?? 0;
    return { interior: at('interior'), exterior: at('exterior') };
  };

  it('crossfades rather than switching, so a climb opens the space', async () => {
    const inside = await rooms(0);
    const outside = await rooms(1);
    const between = await rooms(0.5);
    expect(inside.interior).toBeCloseTo(1, 5);
    expect(inside.exterior).toBeCloseTo(0, 5);
    expect(outside.exterior).toBeCloseTo(1, 5);
    expect(outside.interior).toBeCloseTo(0, 5);
    // Halfway up the ramp is half of each, which is what makes it a climb rather than a
    // level boundary.
    expect(between.interior).toBeCloseTo(0.5, 5);
    expect(between.exterior).toBeCloseTo(0.5, 5);
  });

  it('always has exactly one room\'s worth of tail', async () => {
    for (const space of [0, 0.2, 0.5, 0.8, 1]) {
      const { interior, exterior } = await rooms(space);
      // Or the route would get quieter in the middle of every climb.
      expect(interior + exterior).toBeCloseTo(1, 5);
    }
  });

  it('builds two rooms rather than one, and they are different rooms', async () => {
    const recorder = recordingContext();
    await busWith(recorder);
    // Both impulse responses are generated at `resume`, so the graph's shape is fixed
    // from the first gesture -- the same rule the bed is built under.
    expect(recorder.impulses.length).toBe(2);
    const [interior, exterior] = recorder.impulses;
    expect(exterior.length).toBeGreaterThan(interior.length * 2);
  });
});
