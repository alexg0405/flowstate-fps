import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioManager } from '../src/audio/AudioManager';
import { cueFor, installInterfaceAudio } from '../src/audio/interfaceAudio';

interface Voice { frequency: number; gain: number; type: string; startAt: number }
interface Noise { cutoff: number; gain: number }

/**
 * jsdom has no Web Audio at all, so the bus is exercised against a recorder that
 * implements exactly the surface `AudioManager` uses. Without it these cues would be
 * typechecked and never heard by anything -- which is how the bug in AUDIT.md
 * section 5, where taking damage played the hit-confirm sound, survived as long as
 * it did.
 */
function recordingContext() {
  const voices: Voice[] = [];
  const noises: Noise[] = [];
  let pending: Partial<Noise> = {};

  class Param {
    value = 0;
    constructor(private readonly onSet?: (value: number, at: number) => void) {}
    setValueAtTime(value: number, at: number) { this.value = value; this.onSet?.(value, at); return this; }
    exponentialRampToValueAtTime() { return this; }
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
    level = 0;
    onended: (() => void) | null = null;
    start() { voices.push({ frequency: this.pitch, gain: this.level, type: this.type, startAt: this.startedAt }); }
    stop() {}
  }

  let openOscillator: Oscillator | null = null;
  const context = {
    state: 'running',
    currentTime: 0,
    sampleRate: 48_000,
    destination: new Node(),
    async resume() {},
    createGain() {
      const target = openOscillator;
      const node = new Node() as Node & { gain: Param };
      node.gain = new Param((value) => {
        if (target) target.level = value;
        else if (pending.cutoff !== undefined) { noises.push({ cutoff: pending.cutoff, gain: value }); pending = {}; }
      });
      return node;
    },
    createOscillator() {
      openOscillator = new Oscillator();
      const made = openOscillator;
      // The gain node is created right after, and belongs to this voice.
      queueMicrotask(() => { openOscillator = null; });
      return made;
    },
    createBufferSource() {
      openOscillator = null;
      return Object.assign(new Node(), { buffer: null, onended: null as (() => void) | null, start() {}, stop() {} });
    },
    createBiquadFilter() {
      const node = new Node() as Node & { type: string; frequency: { value: number }; Q: { value: number } };
      node.type = '';
      node.frequency = { value: 0 };
      node.Q = { value: 0 };
      Object.defineProperty(node.frequency, 'value', {
        set(value: number) { pending = { cutoff: value }; },
        get() { return pending.cutoff ?? 0; },
      });
      return node;
    },
    createBuffer(_channels: number, length: number) {
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    },
    close() {},
  };
  return { context, voices, noises };
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

  it('keeps hover an order of magnitude under the hit-confirm blip', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.cue('hover');
    const [hover] = recorder.voices;
    expect(hover).toBeDefined();
    // The confirm blip a landed body shot plays is 0.055. A menu that ticks anywhere
    // near that under the pointer is a menu the player turns off.
    expect(hover.gain).toBeLessThan(0.055 / 3);
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
    // `complete` plays 0.35 s from zero and 0.42 s from 0.12, so it is done at 0.54.
    // Landing the stinger on top of it is how two cues get confused for one.
    const earliest = Math.min(...recorder.voices.map((voice) => voice.startAt));
    expect(earliest).toBeGreaterThan(0.54);
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
    // cut through it: more voices, and a louder one than the body-shot confirm.
    expect(dodgeRecorder.voices.length).toBeGreaterThan(hitRecorder.voices.length);
    const loudestDodge = Math.max(...dodgeRecorder.voices.map((voice) => voice.gain));
    const loudestHit = Math.max(...hitRecorder.voices.map((voice) => voice.gain));
    expect(loudestDodge).toBeGreaterThan(loudestHit);
    // And it rises, where taking damage falls -- the two must never read as the
    // same event, which is the bug AUDIT.md section 5 records.
    const pitches = dodgeRecorder.voices.map((voice) => voice.frequency);
    expect(pitches.at(-1)!).toBeGreaterThan(pitches[0]);
  });

  it('is not the telegraph it answers', async () => {
    const recorder = recordingContext();
    const bus = await busWith(recorder);
    bus.consume([{ id: 1, tick: 1, kind: 'enemyTelegraph', value: 0.42, sourceEntityId: 2, targetEntityId: 1 }]);
    const telegraph = Math.max(...recorder.voices.map((voice) => voice.frequency));

    const dodgeRecorder = recordingContext();
    const dodgeBus = await busWith(dodgeRecorder);
    dodgeBus.consume([{ id: 1, tick: 1, kind: 'dodge', value: 10, targetEntityId: 1, sourceEntityId: 2 }]);
    // Well clear of the wind-up's register, so the answer is not mistaken for another
    // warning arriving on top of the first.
    expect(Math.min(...dodgeRecorder.voices.map((voice) => voice.frequency))).toBeGreaterThan(telegraph);
  });
});

describe('which control earns which acknowledgement', () => {
  const control = (className: string) => {
    const element = document.createElement('button');
    element.className = className;
    return element;
  };

  it('reads the tone off the classes the stylesheet already uses', () => {
    // Sound and colour cannot drift apart if they are driven by the same class.
    expect(cueFor(control('primary jumbo action-primary'))).toBe('confirm');
    expect(cueFor(control('ui-button tone-primary'))).toBe('confirm');
    expect(cueFor(control('danger'))).toBe('cancel');
    expect(cueFor(control('ui-button tone-danger'))).toBe('cancel');
    expect(cueFor(control('utility-action exit-action'))).toBe('cancel');
    expect(cueFor(control('jumbo ghost action-secondary'))).toBe('select');
    expect(cueFor(control(''))).toBe('select');
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
