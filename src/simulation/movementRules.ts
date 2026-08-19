export interface SurfaceResetState {
  airCharge: number;
  lastRechargeSurface: string | null;
}

export function resetFromGround(state: SurfaceResetState): SurfaceResetState {
  return { airCharge: 1, lastRechargeSurface: 'ground' };
}

export function resetFromWall(state: SurfaceResetState, wallId: string): SurfaceResetState {
  if (state.lastRechargeSurface === wallId) return state;
  return { airCharge: 1, lastRechargeSurface: wallId };
}

export function consumeAirCharge(state: SurfaceResetState): SurfaceResetState {
  return { ...state, airCharge: Math.max(0, state.airCharge - 1) };
}

export function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(target, current + maxDelta);
  return Math.max(target, current - maxDelta);
}
