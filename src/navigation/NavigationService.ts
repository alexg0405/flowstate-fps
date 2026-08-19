import { importNavMesh, init, NavMeshQuery, type NavMesh } from 'recast-navigation';
import type { Vec3 } from '../contracts';

let recastInitialization: Promise<void> | null = null;

function initializeRecast(): Promise<void> {
  recastInitialization ??= init();
  return recastInitialization;
}

export class NavigationService {
  private navMesh: NavMesh | null = null;
  private query: NavMeshQuery | null = null;

  async load(data?: Uint8Array): Promise<void> {
    this.dispose();
    if (!data?.byteLength) return;
    await initializeRecast();
    const imported = importNavMesh(data);
    this.navMesh = imported.navMesh;
    this.query = new NavMeshQuery(imported.navMesh, { maxNodes: 1024 });
  }

  nextWaypoint(start: Vec3, goal: Vec3): Vec3 | null {
    if (!this.query) return null;
    const result = this.query.computePath(
      { x: start[0], y: start[1], z: start[2] },
      { x: goal[0], y: goal[1], z: goal[2] },
      { halfExtents: { x: 2, y: 4, z: 2 }, maxPathPolys: 128, maxStraightPathPoints: 32 },
    );
    if (!result.success || result.path.length < 2) return null;
    const point = result.path[1];
    return [point.x, point.y, point.z];
  }

  dispose(): void {
    this.query?.destroy();
    this.navMesh?.destroy();
    this.query = null;
    this.navMesh = null;
  }
}
