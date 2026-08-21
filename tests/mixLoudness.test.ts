import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameEvent } from '../src/contracts';
import { AudioManager, type AudioSustainState } from '../src/audio/AudioManager';
import { createOfflineAudio, type OfflineAudio } from './support/offlineAudio';
import { measureMix, type MixMeasurement } from './support/loudness';

/**
 * Measuring the mix, which is the answer to the standing problem that whoever works on it
 * cannot hear it.
 *
 * Every other audio test in this repo asserts what the mix was *told* to play: a
 * recording double catches the frequencies, gains and layers each cue asks for. None of
 * them can catch the failure a synthesised mix is most prone to, which is three cues
 * landing together and clipping the output -- because that failure is not in any one
 * cue's numbers, it is in their sum after a convolver, a duck and a limiter have had
 * their say. That needs a render.
 *
 * `tests/support/offlineAudio.ts` renders the real graph; `tests/support/loudness.ts` is
 * BS.1770-4. The tape below is one representative fight. What it turns "I think the kill
 * is too loud" into is a number.
 */

/** Six seconds is long enough for one short-term window and a whole exchange. */
const TAPE_SECONDS = 6;

/** Ticks are the simulation's own, at 60 Hz, because that is what a cue is scheduled off. */
const tickAt = (seconds: number) => Math.round(seconds * 60);

let identifier = 0;
function event(kind: GameEvent['kind'], seconds: number, extra: Partial<GameEvent> = {}): GameEvent {
  identifier += 1;
  return { id: identifier, tick: tickAt(seconds), kind, ...extra };
}

const idle: AudioSustainState = { speed: 0, threat: 0, down: false, space: 0.15, chain: { links: 0, window: 0 } };

interface TapeEntry {
  at: number;
  events?: readonly GameEvent[];
  sustain?: AudioSustainState;
}

/**
 * Runs a tape through the real `AudioManager` and measures what comes out of the
 * destination. The clock is advanced between entries so voices end when they would end:
 * the mix counts its own live voices to decide what is worth playing, and a render that
 * never ended one would be measuring a graph the runtime never produces.
 */
async function render(tape: readonly TapeEntry[], listener?: Parameters<AudioManager['consume']>[1]): Promise<MixMeasurement> {
  const engine: OfflineAudio = createOfflineAudio(TAPE_SECONDS);
  vi.stubGlobal('AudioContext', function AudioContextStub(this: unknown) { return engine; } as unknown as typeof AudioContext);
  const bus = new AudioManager();
  await bus.resume();
  for (const entry of [...tape].sort((a, b) => a.at - b.at)) {
    engine.advanceTo(entry.at);
    if (entry.sustain) bus.sustain(entry.sustain);
    if (entry.events) bus.consume(entry.events, listener);
  }
  return measureMix(engine.render());
}

beforeEach(() => { vi.unstubAllGlobals(); identifier = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('the meter itself', () => {
  it('reads a full-scale stereo sine as nought, which is what the standard says', async () => {
    // The apparatus before the measurement. A 1 kHz sine at full scale on both channels
    // is 0 LUFS by construction -- the standard's -0.691 offset exists to make it so --
    // and if this drifts, every number below is measuring the meter rather than the mix.
    const engine = createOfflineAudio(2);
    const oscillator = engine.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = 1000;
    oscillator.connect(engine.destination);
    oscillator.start(0);
    oscillator.stop(2);
    const measured = measureMix(engine.render());
    expect(measured.maxMomentaryLufs).toBeGreaterThan(-0.5);
    expect(measured.maxMomentaryLufs).toBeLessThan(0.5);
    expect(measured.samplePeakDb).toBeGreaterThan(-0.2);
    expect(measured.truePeakDb).toBeGreaterThan(measured.samplePeakDb - 0.1);
  });
});

/** One arena: movement, a burst, a telegraph answered, a chain, and two bodies down. */
const fight: readonly TapeEntry[] = [
  { at: 0, sustain: { speed: 6, threat: 3, down: false, space: 0.15, chain: { links: 0, window: 0 } } },
  { at: 0.25, sustain: { speed: 11, threat: 3, down: false, space: 0.15, chain: { links: 1, window: 1 } } },
  { at: 0.3, events: [event('shot', 0.3), event('impact', 0.3, { position: [4, 1, -6] })] },
  { at: 0.45, events: [event('shot', 0.45), event('hit', 0.45, { targetEntityId: 7, value: 24 })] },
  { at: 0.6, events: [event('shot', 0.6), event('hit', 0.6, { targetEntityId: 7, value: 26, headshot: true })] },
  { at: 0.75, sustain: { speed: 13, threat: 3, down: false, space: 0.15, chain: { links: 2, window: 0.9 } } },
  { at: 0.9, events: [event('enemyTelegraph', 0.9, { position: [9, 1, -14], sourceEntityId: 7, value: 0.34 })] },
  { at: 1.25, sustain: { speed: 14, threat: 3, down: false, space: 0.15, chain: { links: 3, window: 0.8 } } },
  { at: 1.3, events: [event('dodge', 1.3, { value: 18 })] },
  { at: 1.6, events: [event('melee', 1.6, { targetEntityId: 7 }), event('comboLink', 1.6, { value: 4 })] },
  { at: 1.75, sustain: { speed: 12, threat: 3, down: false, space: 0.15, chain: { links: 4, window: 0.9 } } },
  { at: 2.1, events: [event('melee', 2.1, { targetEntityId: 7, heavy: true }), event('kill', 2.1, { targetEntityId: 7 }), event('heal', 2.1, { value: 9 }), event('comboLink', 2.1, { value: 5 })] },
  { at: 2.25, sustain: { speed: 9, threat: 2, down: false, space: 0.15, chain: { links: 5, window: 1 } } },
  { at: 2.75, sustain: { speed: 15, threat: 2, down: false, space: 0.15, chain: { links: 5, window: 0.6 } } },
  { at: 3, events: [event('enemyAttack', 3, { position: [-7, 1, -11], sourceEntityId: 8, value: 11 }), event('hit', 3, { targetEntityId: 1, value: 11 })] },
  { at: 3.25, sustain: { speed: 10, threat: 2, down: false, space: 0.15, chain: { links: 5, window: 0.3 } } },
  { at: 3.6, events: [event('melee', 3.6, { targetEntityId: 8, heavy: true }), event('kill', 3.6, { targetEntityId: 8 }), event('heal', 3.6, { value: 14 }), event('comboLink', 3.6, { value: 6 })] },
  { at: 3.75, sustain: { speed: 8, threat: 1, down: false, space: 0.15, chain: { links: 6, window: 1 } } },
  { at: 4.25, sustain: { speed: 5, threat: 1, down: false, space: 0.15, chain: { links: 6, window: 0.4 } } },
  { at: 4.6, events: [event('comboBreak', 4.6)] },
  { at: 4.75, sustain: { speed: 3, threat: 1, down: false, space: 0.15, chain: { links: 0, window: 0 } } },
  { at: 5.25, sustain: idle },
  { at: 5.75, sustain: idle },
];

describe('the mix, measured', () => {
  it('keeps a fight under the true-peak ceiling the industry sets', async () => {
    const measured = await render(fight);
    // -1 dBFS is the published ceiling, and the one number in this file that is not a
    // judgement call: past it, a converter reconstructs a waveform the mix never made.
    // This tape measures -12.5 dBFS, so the ceiling is not the binding constraint -- see
    // the loudness case below for what the spare eleven decibels mean.
    expect(measured.truePeakDb).toBeLessThan(-1);
    expect(measured.truePeakDb).toBeGreaterThan(-24);
  }, 60_000);

  it('sits an arena in the band this mix is currently authored at', async () => {
    const measured = await render(fight);
    // What this tape measures today, and the first honest numbers this mix has ever had:
    //
    //     true peak      -12.5 dBFS
    //     integrated     -31.6 LUFS
    //     short-term max -30.9 LUFS
    //     momentary max  -28.7 LUFS
    //
    // The industry target is -23 LUFS with true peak under -1 dBFS, so **this mix is
    // roughly eight decibels quiet and is throwing away eleven decibels of headroom.**
    // That is a level decision and not a bug, and it is deliberately not fixed here: the
    // constants to turn are `BUS_LEVEL` in `AudioManager` and `audioMix.defaultVolume`
    // in `content/config.ts`, and whoever turns them should listen to the result. What
    // the band below does is make the *next* move deliberate -- the mix cannot drift
    // several decibels in either direction again without a test saying so.
    expect(measured.integratedLufs).toBeGreaterThan(-36);
    expect(measured.integratedLufs).toBeLessThan(-22);
    // Short-term is the figure that matters for material this short, and it sits above
    // the integrated one -- that is what a fight is.
    expect(measured.maxShortTermLufs).toBeGreaterThan(measured.integratedLufs - 3);
  }, 60_000);

  it('does not clip when a heavy finishes three hostiles on one tick', async () => {
    // The worst case the shipped content can produce in one batch: a heavy sweeps a
    // 160-degree arc, and the Roofline puts eight hostiles on the deck. Three bodies
    // going down together used to be the same waveform nine decibels louder.
    const stack: readonly TapeEntry[] = [
      { at: 0, sustain: { speed: 14, threat: 5, down: false, space: 0.15, chain: { links: 7, window: 1 } } },
      {
        at: 0.5,
        events: [
          event('melee', 0.5, { targetEntityId: 7, heavy: true }),
          event('hit', 0.5, { targetEntityId: 7, value: 82 }),
          event('hit', 0.5, { targetEntityId: 8, value: 82 }),
          event('hit', 0.5, { targetEntityId: 9, value: 82 }),
          event('kill', 0.5, { targetEntityId: 7 }),
          event('kill', 0.5, { targetEntityId: 8 }),
          event('kill', 0.5, { targetEntityId: 9 }),
          event('heal', 0.5, { value: 18 }),
          event('comboLink', 0.5, { value: 8 }),
          event('comboLink', 0.5, { value: 9 }),
          event('comboLink', 0.5, { value: 10 }),
        ],
      },
      { at: 1.5, sustain: { speed: 12, threat: 2, down: false, space: 0.15, chain: { links: 10, window: 1 } } },
      { at: 3, sustain: idle },
    ];
    const measured = await render(stack);
    // Measured at -2.0 dBFS, which is the tightest margin in the mix and the number to
    // watch: the tape renders at full volume, so this *is* the worst case a player can
    // reach, and there is one decibel between it and a converter clipping.
    expect(measured.truePeakDb).toBeLessThan(-1);
  }, 60_000);

  it('holds a floor under a live room, and takes it away when the player goes down', async () => {
    const held = (state: AudioSustainState) => [0, 2, 4].map((at) => ({ at, sustain: state }));
    const alive = await render(held({ speed: 12, threat: 4, down: false, space: 0.15, chain: { links: 3, window: 1 } }));
    const down = await render(held({ speed: 0, threat: 4, down: true, space: 0.15, chain: { links: 0, window: 0 } }));
    // Nothing is played in either of these: this is a measurement of the bed alone. A
    // live room has to be audible without music, which is a level rather than an
    // assertion about a gain node, and going down is meant to be the floor *leaving*
    // rather than a quieter version of the same room.
    expect(alive.maxShortTermLufs).toBeGreaterThan(-45);
    expect(down.maxShortTermLufs).toBeLessThan(alive.maxShortTermLufs - 20);
  }, 60_000);
});
