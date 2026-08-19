/// <reference lib="webworker" />
import { init } from 'recast-navigation';
import { generateSoloNavMeshData } from 'recast-navigation/generators';
import type { CollisionPrimitiveV2, LevelDocumentV2 } from '../contracts';

self.onmessage = async (event: MessageEvent<LevelDocumentV2>) => {
  try {
    await init();
    const { positions, indices } = collisionGeometry(event.data);
    const result = generateSoloNavMeshData(positions, indices, {
      cs: 0.2,
      ch: 0.1,
      walkableSlopeAngle: 48,
      walkableHeight: 1.75,
      walkableClimb: 0.42,
      walkableRadius: 0.35,
      offMeshConnections: event.data.offMeshLinks.map((link, index) => ({
        startPosition: { x: link.start[0], y: link.start[1], z: link.start[2] },
        endPosition: { x: link.end[0], y: link.end[1], z: link.end[2] },
        radius: 0.45,
        bidirectional: link.bidirectional,
        area: 0,
        flags: 1,
        userId: index + 1,
      })),
    });
    if (!result.success) throw new Error(result.error);
    const navMeshData = result.navMeshData.toTypedArray();
    result.navMeshData.destroy();
    self.postMessage({ success: true, navMeshData }, { transfer: [navMeshData.buffer] });
  } catch (reason) {
    self.postMessage({ success: false, error: reason instanceof Error ? reason.message : String(reason) });
  }
};

/** Builds nav input from the exact authored collision transform, never render meshes. */
export function collisionGeometry(level: LevelDocumentV2): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const primitive of level.collision.filter((item) => item.collision && item.nav.includeInBake && item.nav.walkable)) {
    const base = positions.length / 3;
    for (const point of transformedCorners(primitive)) positions.push(point[0], point[1], point[2]);
    // Bottom, top, front, back, left, right. Winding is outward-facing.
    const faces = [
      0, 1, 2, 0, 2, 3,
      4, 6, 5, 4, 7, 6,
      0, 5, 1, 0, 4, 5,
      3, 2, 6, 3, 6, 7,
      0, 3, 7, 0, 7, 4,
      1, 5, 6, 1, 6, 2,
    ];
    for (const index of faces) indices.push(base + index);
  }
  return { positions, indices };
}

function transformedCorners(primitive: CollisionPrimitiveV2): readonly (readonly [number, number, number])[] {
  const [sx, sy, sz] = primitive.transform.scale;
  const [tx, ty, tz] = primitive.transform.position;
  const [rx, ry, rz] = primitive.transform.rotation;
  const quaternion = eulerQuaternion(rx, ry, rz);
  const local: readonly (readonly [number, number, number])[] = [
    [-sx / 2, -sy / 2, -sz / 2], [sx / 2, -sy / 2, -sz / 2],
    [sx / 2, -sy / 2, sz / 2], [-sx / 2, -sy / 2, sz / 2],
    [-sx / 2, sy / 2, -sz / 2], [sx / 2, sy / 2, -sz / 2],
    [sx / 2, sy / 2, sz / 2], [-sx / 2, sy / 2, sz / 2],
  ];
  return local.map(([x, y, z]) => {
    const ix = quaternion.w * x + quaternion.y * z - quaternion.z * y;
    const iy = quaternion.w * y + quaternion.z * x - quaternion.x * z;
    const iz = quaternion.w * z + quaternion.x * y - quaternion.y * x;
    const iw = -quaternion.x * x - quaternion.y * y - quaternion.z * z;
    return [
      ix * quaternion.w + iw * -quaternion.x + iy * -quaternion.z - iz * -quaternion.y + tx,
      iy * quaternion.w + iw * -quaternion.y + iz * -quaternion.x - ix * -quaternion.z + ty,
      iz * quaternion.w + iw * -quaternion.z + ix * -quaternion.y - iy * -quaternion.x + tz,
    ] as const;
  });
}

function eulerQuaternion(x: number, y: number, z: number): { x: number; y: number; z: number; w: number } {
  const cx = Math.cos(x / 2); const sx = Math.sin(x / 2);
  const cy = Math.cos(y / 2); const sy = Math.sin(y / 2);
  const cz = Math.cos(z / 2); const sz = Math.sin(z / 2);
  return {
    x: sx * cy * cz - cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz + sx * sy * sz,
  };
}
