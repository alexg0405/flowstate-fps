import type { GameEvent, Vec3 } from '../contracts';

/** Where the player is and which way they face, so threats can be placed in the mix. */
export interface AudioListenerState {
  position: Vec3;
  yaw: number;
  playerId: number;
}

interface Voice {
  frequency: number;
  duration: number;
  gain: number;
  type: OscillatorType;
  /** Ratio the pitch slides to across the duration. 1 holds it flat. */
  bend?: number;
}

/** Beyond this a source contributes nothing, so distant fights stay out of the way. */
const MAX_AUDIBLE_METRES = 55;
/** Cap on impact ticks per batch, so a shotgun shell does not fire eight voices. */
const MAX_IMPACTS_PER_BATCH = 2;

export class AudioManager {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  async resume(): Promise<void> {
    if (typeof AudioContext !== 'function') return;
    try {
      this.context ??= new AudioContext();
      if (this.context.state !== 'running') await this.context.resume();
      this.master ??= this.createMaster(this.context);
      this.noiseBuffer ??= this.createNoiseBuffer(this.context);
    } catch {
      this.context = null;
      this.master = null;
    }
  }

  consume(events: readonly GameEvent[], listener?: AudioListenerState): void {
    if (!this.context || this.context.state !== 'running') return;
    let impacts = 0;
    for (const event of events) {
      const place = this.placement(event, listener);
      switch (event.kind) {
        case 'shot':
          // The player's own weapon is always centred and always at full level; it
          // is the one sound that must never be masked by the mix.
          this.crack(150, 0.075, 0.1, 0);
          this.tone({ frequency: 210, duration: 0.05, gain: 0.075, type: 'sawtooth', bend: 0.45 }, 0, 0);
          break;
        case 'dryFire':
          this.crack(2600, 0.022, 0.05, 0);
          break;
        case 'impact':
          // Body shots already get the confirm blip, so only surfaces tick here.
          if (event.targetEntityId !== undefined || impacts >= MAX_IMPACTS_PER_BATCH) break;
          impacts += 1;
          this.crack(1500, 0.035, 0.03 * place.gain, place.pan);
          break;
        case 'hit':
          if (this.isPlayer(event.targetEntityId, listener)) this.playerDamaged(event.value ?? 0);
          // Headshots ring higher than body hits so the confirmation is audible.
          else this.tone({ frequency: event.headshot ? 1180 : 640, duration: 0.035, gain: 0.055, type: 'square' }, 0, 0);
          break;
        case 'kill':
          this.tone({ frequency: 880, duration: 0.08, gain: 0.08, type: 'sine' }, 0, 0);
          this.tone({ frequency: 1320, duration: 0.14, gain: 0.05, type: 'triangle' }, 0, 0);
          break;
        case 'melee':
          this.crack(700, 0.09, 0.06, 0);
          this.tone({ frequency: 320, duration: 0.09, gain: 0.05, type: 'triangle', bend: 0.6 }, 0, 0);
          break;
        case 'enemyTelegraph':
          // The single most important cue in the mix: it is the only warning the
          // player gets before taking damage, so it rises and it is placed.
          this.tone({ frequency: 300, duration: Math.max(0.12, event.value ?? 0.3), gain: 0.09 * place.gain, type: 'square', bend: 2.1 }, 0, place.pan);
          break;
        case 'enemyAttack':
          // Duller and lower than the player's own shot so the two never blur.
          this.crack(320, 0.07, 0.075 * place.gain, place.pan);
          this.tone({ frequency: 130, duration: 0.06, gain: 0.06 * place.gain, type: 'square', bend: 0.55 }, 0, place.pan);
          break;
        case 'death':
          this.tone({ frequency: 320, duration: 0.7, gain: 0.11, type: 'sawtooth', bend: 0.22 }, 0, 0);
          this.crack(140, 0.4, 0.12, 0);
          break;
        case 'respawn':
          // Rises where death fell, so redeploying reads as the inverse of going down.
          this.tone({ frequency: 260, duration: 0.28, gain: 0.08, type: 'triangle', bend: 2.4 }, 0, 0);
          break;
        case 'comboLink': {
          // Pitch climbs with the chain, so the chain is audible without being read.
          const step = Math.min(16, event.value ?? 1);
          this.tone({ frequency: 520 * (1 + step * 0.055), duration: 0.06, gain: 0.045, type: 'triangle' }, 0, 0);
          break;
        }
        case 'comboBreak':
          this.tone({ frequency: 420, duration: 0.2, gain: 0.05, type: 'triangle', bend: 0.42 }, 0, 0);
          break;
        case 'split':
          this.tone({ frequency: 980, duration: 0.09, gain: 0.05, type: 'sine' }, 0, 0);
          this.tone({ frequency: 1470, duration: 0.11, gain: 0.035, type: 'sine' }, 0.05, 0);
          break;
        case 'reloadStart':
          this.crack(900, 0.04, 0.045, 0);
          break;
        case 'reloadComplete':
          this.crack(1700, 0.035, 0.05, 0);
          this.tone({ frequency: 520, duration: 0.05, gain: 0.035, type: 'square' }, 0, 0);
          break;
        case 'checkpoint':
          this.tone({ frequency: 520, duration: 0.18, gain: 0.07, type: 'sine' }, 0, 0);
          this.tone({ frequency: 780, duration: 0.26, gain: 0.045, type: 'sine' }, 0.07, 0);
          break;
        case 'complete':
          this.tone({ frequency: 740, duration: 0.35, gain: 0.08, type: 'sine' }, 0, 0);
          this.tone({ frequency: 1110, duration: 0.42, gain: 0.05, type: 'triangle' }, 0.12, 0);
          break;
        case 'gateOpen':
          this.tone({ frequency: 90, duration: 0.55, gain: 0.08 * place.gain, type: 'sawtooth', bend: 1.7 }, 0, place.pan);
          break;
        case 'grappleAttach':
          this.tone({ frequency: 420, duration: 0.09, gain: 0.06, type: 'sawtooth' }, 0, 0);
          break;
        case 'grapplePull':
          this.tone({ frequency: 520, duration: 0.07, gain: 0.055, type: 'sawtooth', bend: 1.35 }, 0, 0);
          break;
        case 'grappleRelease':
          this.tone({ frequency: 260, duration: 0.07, gain: 0.035, type: 'sine' }, 0, 0);
          break;
        case 'grappleFail':
          this.tone({ frequency: 120, duration: 0.035, gain: 0.02, type: 'square' }, 0, 0);
          break;
        default:
          break;
      }
    }
  }

  dispose(): void {
    void this.context?.close();
    this.context = null;
    this.master = null;
    this.noiseBuffer = null;
  }

  /**
   * Damage taken is deliberately built from different material than damage dealt:
   * a noise thud plus a falling tone, never the hit-confirm blip. Reading the mix
   * has to tell the player which direction the transaction went.
   */
  private playerDamaged(amount: number): void {
    const weight = Math.min(1, Math.max(0.25, amount / 25));
    this.crack(190, 0.14, 0.12 * weight, 0);
    this.tone({ frequency: 240, duration: 0.2, gain: 0.09 * weight, type: 'triangle', bend: 0.4 }, 0, 0);
  }

  /** Distance attenuation and stereo placement for a world-positioned event. */
  private placement(event: GameEvent, listener?: AudioListenerState): { gain: number; pan: number } {
    const source = event.origin ?? event.position;
    if (!listener || !source) return { gain: 1, pan: 0 };
    const dx = source[0] - listener.position[0];
    const dy = source[1] - listener.position[1];
    const dz = source[2] - listener.position[2];
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 0.001) return { gain: 1, pan: 0 };
    // Matches the simulation's basis: forward is (-sin yaw, -cos yaw), so right is
    // (cos yaw, -sin yaw) and a positive dot puts the source to the player's right.
    const pan = (dx * Math.cos(listener.yaw) + dz * -Math.sin(listener.yaw)) / distance;
    return { gain: Math.max(0, 1 - distance / MAX_AUDIBLE_METRES) ** 1.4, pan };
  }

  private isPlayer(entityId: number | undefined, listener?: AudioListenerState): boolean {
    return entityId !== undefined && entityId === listener?.playerId;
  }

  private createMaster(context: AudioContext): GainNode {
    const master = context.createGain();
    master.gain.value = 0.75;
    master.connect(context.destination);
    return master;
  }

  private createNoiseBuffer(context: AudioContext): AudioBuffer {
    const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * 0.5), context.sampleRate);
    const channel = buffer.getChannelData(0);
    // Deterministic noise: presentation is allowed to be arbitrary but it should
    // not differ run to run for the same event.
    let state = 0x9e3779b9;
    for (let index = 0; index < channel.length; index += 1) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      channel[index] = ((state >>> 0) / 0x8000_0000) - 1;
    }
    return buffer;
  }

  /**
   * Per-voice tail of the graph. A panned voice needs its own panner, which has to
   * be torn down when the voice ends -- otherwise every placed sound leaves a node
   * connected to the master for the rest of the session.
   */
  private output(pan: number): { destination: AudioNode; release: () => void } | null {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return null;
    if (pan === 0 || typeof context.createStereoPanner !== 'function') {
      return { destination: master, release: () => {} };
    }
    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    panner.connect(master);
    return { destination: panner, release: () => panner.disconnect() };
  }

  /** Filtered noise burst. Carries every percussive cue: shots, impacts, thuds. */
  private crack(cutoff: number, duration: number, gainValue: number, pan: number): void {
    const context = this.context;
    const output = this.output(pan);
    if (!context || !output || !this.noiseBuffer || gainValue <= 0.0005) {
      output?.release();
      return;
    }
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = cutoff;
    filter.Q.value = 0.9;
    const gain = context.createGain();
    gain.gain.setValueAtTime(gainValue, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration);
    source.connect(filter).connect(gain).connect(output.destination);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
      output.release();
    };
    source.start();
    source.stop(context.currentTime + duration);
  }

  private tone({ frequency, duration, gain: gainValue, type, bend }: Voice, delaySeconds: number, pan: number): void {
    const context = this.context;
    const output = this.output(pan);
    if (!context || !output || gainValue <= 0.0005) {
      output?.release();
      return;
    }
    const startAt = context.currentTime + Math.max(0, delaySeconds);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startAt);
    if (bend && bend !== 1) oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, frequency * bend), startAt + duration);
    gain.gain.setValueAtTime(gainValue, startAt);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    oscillator.connect(gain).connect(output.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
      output.release();
    };
    oscillator.start(startAt);
    oscillator.stop(startAt + duration);
  }
}
