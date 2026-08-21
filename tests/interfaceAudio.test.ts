import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameEvent } from '../src/contracts';
import { AudioManager } from '../src/audio/AudioManager';
import { cueFor, installInterfaceAudio } from '../src/audio/interfaceAudio';

interface Voice { frequency: number; gain: number; type: string; startAt: number; filter: string | null }
interface Noise { cutoff: number; gain: number; filter: string }
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
  // left source-less is the bus, the two sends, and the bed's two output gains.
  const shared: string[] = ['bus', 'wetNear', 'wetFar', 'floor', 'drive'];
  const bedAutomation: { node: string; value: number }[] = [];
  let sharedCount = 0;

  class Param {
    value = 0;
    constructor(private readonly onSet?: (value: number, at: number) => void) {}
    setValueAtTime(value: number, at: number) { this.value = value; this.onSet?.(value, at); return this; }
    exponentialRampToValueAtTime(_value: number, _at: number): Param { return this; }
    linearRampToValueAtTime() { return this; }
    setTargetAtTime(_value: number, _at: number, _constant: number): Param { return this; }
    cancelScheduledValues() { return this; }
  }
  class Node {
    connect(next: Node) { return next; }
    disconnect() {}
  }
  class Oscillator extends Node {
    type = '';
    startedAt = 0;
    frequency = new Param((value, at) => { this.pitch = value; this.startedAt = at; });
    pitch = 0;
    onended: (() => void) | null = null;
    start() {}
    stop() {}
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
        const param = new Param((value, at) => {
          if (record) record.push({ value, at });
          else bedAutomation.push({ node: label ?? '?', value });
        });
        param.exponentialRampToValueAtTime = (value: number, at: number) => {
          if (record) record.push({ value, at });
          return param;
        };
        param.setTargetAtTime = (value: number) => {
          if (!record) bedAutomation.push({ node: label ?? '?', value });
          return param;
        };
        node.gain = param;
        return node;
      }
      node.connect = (next: Node & { label?: string }) => {
        if (next.label) sends.push(next.label);
        return next;
      };
      node.gain = new Param((value) => {
        if (source.kind === 'osc') {
          voices.push({ frequency: source.node.pitch, gain: value, type: source.node.type, startAt: source.node.startedAt, filter: filter?.type ?? null });
        } else if (filter) {
          noises.push({ cutoff: filter.frequency, gain: value, filter: filter.type });
        }
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
      return Object.assign(new Node(), { buffer: null, onended: null as (() => void) | null, start() {}, stop() {} });
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
      node.pan = { value: 0 };
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
      return { numberOfChannels: channels, getChannelData: (channel: number) => data[channel] };
    },
    close() {},
  };
  return { context, voices, noises, ducks, sends, bedAutomation, filterCutoffs };
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
  const at = (speed: number, threat: number, down = false) => ({ speed, threat, down });

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

describe('the register itself', () => {
  /**
   * One of every cue the run can play, with the fields each one reads. This is the
   * guard on the thing the whole pass was about: it is easy to add a cue, and just as
   * easy to reach for a 900 Hz square while doing it.
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
