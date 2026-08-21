/**
 * A GPU-free look at what each authored camera cone actually frames.
 *
 * This is not a render and is not trying to be one. It projects the level's own boxes
 * through the real camera -- `settings.fov` 92, which is a *vertical* angle, so about
 * 122 degrees horizontally at 16:9 -- and fills each silhouette flat. What it answers is
 * the only question a blockout has: what occupies the frame, and how much of it.
 *
 * It has caught five things a plan view could not. A twenty-six metre wall stood nine
 * metres to the player's right at the reveal and closed the entire flank the composition
 * was built to open. The hero mass, sized off the reference photograph, came out a fifth
 * of the frame wide, because a 122-degree field shrinks everything in it. A foreground
 * arch failed at three separate distances. The overlook's parapet was taller than the
 * player standing behind it. And the whole exercise was being judged from a level camera
 * until `VistaCone.pitch` existed, which is the angle none of these shots are authored
 * for.
 *
 * What it leaves out, and why the real frame is richer than this: the 180-tower
 * procedural skyline and the sky traffic (both built in `WorldPresenter`, not authored in
 * the level), the city's ground plane, every window and light, the deck and wall art the
 * route primitives actually wear, and the face-paint colour system. Judge silhouette,
 * scale and placement here. Judge colour and detail on a GPU.
 *
 * Writes nothing unless `PREVIEW_OUT` names a directory:
 * `PREVIEW_OUT=/tmp/shots npx vitest run tests/compositionPreview.test.ts`
 */
import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { defaultLevel } from '../src/content/defaultLevel';
import { vistaBlockout, vistaCones } from '../src/content/vistaBlockout';
import type { LevelDocumentV2, VistaHint } from '../src/contracts';

const W = 1280;
const H = 720;
const FOV = 92;
const tanHalfV = Math.tan(((FOV / 2) * Math.PI) / 180);
const tanHalfH = tanHalfV * (16 / 9);
const OUT = process.env.PREVIEW_OUT;

interface P { x: number; y: number }

function corners(t: { position: readonly number[]; rotation: readonly number[]; scale: readonly number[] }) {
  const [cx, cy, cz] = t.position;
  const [sx, sy, sz] = t.scale;
  const yaw = t.rotation[1];
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const out: { x: number; y: number; z: number }[] = [];
  for (const dx of [-sx / 2, sx / 2]) for (const dy of [-sy / 2, sy / 2]) for (const dz of [-sz / 2, sz / 2]) {
    out.push({ x: cx + dx * cos + dz * sin, y: cy + dy, z: cz - dx * sin + dz * cos });
  }
  return out;
}

function hull(points: P[]): P[] {
  if (points.length < 3) return points;
  const sorted = [...points].sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const cross = (o: P, a: P, b: P) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const build = (source: P[]) => {
    const stack: P[] = [];
    for (const point of source) {
      while (stack.length >= 2 && cross(stack[stack.length - 2], stack[stack.length - 1], point) <= 0) stack.pop();
      stack.push(point);
    }
    return stack;
  };
  const lower = build(sorted);
  const upper = build([...sorted].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * Roughly what the renderer will put on a surface, which is *not* the `color` on the
 * primitive -- `createArchitecture` ignores that field entirely and reaches for the
 * material library instead, and route primitives with catalogued art do not go through
 * `createArchitecture` at all.
 *
 * The deck value was wrong twice and both times it inverted the whole frame. Reading the
 * authored `#f2f0e8` made every deck near-white. Guessing `#cfd3c8` from that was no
 * better: it put a pale floor across the bottom third of every shot and had me reporting
 * that the ground was the brightest mass in the composition. It is not. AUDIT section 11
 * records the deck top's albedo being fixed at source and the scene measuring
 * **rgb(31,39,45)** six seconds after load, and `materials.get('deck')` is `#2b3743`.
 * The floor is dark, the sky is the brightest thing, and that was already true before
 * any of this work started.
 *
 * The measurement predates the authored tone curve replacing ACES at 0.52 exposure, so
 * treat it as the right order of magnitude rather than the exact pixel.
 */
function tone(entry: { collision: boolean; surface: string; color: string }): string {
  if (!entry.collision) return entry.color;
  if (entry.surface === 'wall-run') return '#163e49';
  if (entry.surface === 'vault' || entry.surface === 'mantle') return '#252f3a';
  if (entry.surface === 'no-traverse') return '#1b232c';
  return '#1f272d';
}

/**
 * White Line has no `VistaCone` list -- cones are a blockout idea. It has hints, which
 * carry the same three numbers the projection needs, so it is drawn from those.
 */
const shots: readonly { prefix: string; level: LevelDocumentV2; cones: readonly { id: string; origin: readonly number[]; yaw: number; pitch: number; subject: string }[] }[] = [
  { prefix: 'cone', level: vistaBlockout, cones: vistaCones },
  {
    prefix: 'route',
    level: defaultLevel,
    cones: [
      ...defaultLevel.vistaHints.map((hint: VistaHint) => ({
        id: hint.id.replace(/^hint-/, ''),
        origin: hint.at,
        yaw: hint.yaw,
        pitch: hint.pitch,
        subject: 'White Line, from the hint that arms here.',
      })),
      // The rooms themselves, from the checkpoint each one puts the player on. No hint
      // arms in here -- a hostile inside 45 m disarms the nudge -- so these are drawn at
      // a level camera, which is what a player in a fight is actually looking at.
      ...defaultLevel.encounters.map((encounter) => ({
        id: encounter.label.toLowerCase(),
        origin: encounter.checkpoint,
        yaw: 0,
        pitch: 0,
        subject: `${encounter.label}, from its checkpoint, at the pitch a fight is fought at.`,
      })),
    ],
  },
];

describe('composition preview', () => {
  it.skipIf(!OUT)('projects each cone', () => {
    for (const { prefix, level, cones } of shots) for (const cone of cones) {
      const eye = { x: cone.origin[0], y: cone.origin[1] + 0.4, z: cone.origin[2] };
      const forward = { x: -Math.sin(cone.yaw), z: -Math.cos(cone.yaw) };
      const right = { x: Math.cos(cone.yaw), z: -Math.sin(cone.yaw) };
      const cosPitch = Math.cos(cone.pitch);
      const sinPitch = Math.sin(cone.pitch);
      const shapes: { depth: number; points: P[]; color: string; id: string }[] = [];

      for (const entry of level.collision) {
        // Camera space for all eight corners first. A box that straddles the near plane
        // -- which every wall the player is standing next to does -- has to be clipped
        // edge by edge, not corner by corner: dropping the corners behind the camera
        // collapsed a twenty-six metre wall three metres away into a sliver at its far
        // end, which is exactly backwards from what it does to the frame.
        const view = corners(entry.transform).map((corner) => {
          const across = (corner.x - eye.x) * right.x + (corner.z - eye.z) * right.z;
          const along = (corner.x - eye.x) * forward.x + (corner.z - eye.z) * forward.z;
          const up = corner.y - eye.y;
          // Pitch rotates the view in the along/up plane. Without this the preview only
          // ever showed the level from a dead-level camera, which is the one angle the
          // composition is *not* authored for.
          return {
            x: across,
            y: up * cosPitch - along * sinPitch,
            z: along * cosPitch + up * sinPitch,
          };
        });
        const EDGES: [number, number][] = [
          [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3],
          [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7],
        ];
        const NEAR = 0.6;
        const clipped: typeof view = [];
        for (const point of view) if (point.z > NEAR) clipped.push(point);
        for (const [a, b] of EDGES) {
          const p = view[a];
          const q = view[b];
          if ((p.z > NEAR) === (q.z > NEAR)) continue;
          const t = (NEAR - p.z) / (q.z - p.z);
          clipped.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, z: NEAR });
        }
        if (clipped.length < 3) continue;
        const projected: P[] = clipped.map((point) => ({
          x: ((point.x / point.z) / tanHalfH * 0.5 + 0.5) * W,
          y: (0.5 - (point.y / point.z) / tanHalfV * 0.5) * H,
        }));
        // Depth for sorting comes from the box centre, not the clipped corners, so a
        // wall the camera is inside does not sort itself behind the city.
        const depthSum = view.reduce((sum, point) => sum + point.z, 0);
        const seen = view.length;
        const points = hull(projected);
        const inFrame = points.some((p) => p.x > -600 && p.x < W + 600 && p.y > -1200 && p.y < H + 600);
        if (!inFrame) continue;
        shapes.push({ depth: depthSum / seen, points, color: tone(entry), id: entry.id });
      }

      shapes.sort((a, b) => b.depth - a.depth);
      // Where the ground plane's horizon lands once the camera is pitched.
      const horizonY = (0.5 + Math.tan(cone.pitch) / tanHalfV * 0.5) * H;
      const body = shapes.map((shape) => {
        const d = shape.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
        return `<polygon points="${d}" fill="${shape.color}" stroke="#000" stroke-opacity=".55" stroke-width="1"><title>${shape.id}</title></polygon>`;
      }).join('\n');

      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#0a1420"/><stop offset="0.55" stop-color="#3a1a3c"/><stop offset="1" stop-color="#8d3457"/>
</linearGradient><clipPath id="frame"><rect width="${W}" height="${H}"/></clipPath></defs>
<rect width="${W}" height="${H}" fill="url(#sky)"/>
<rect y="${horizonY.toFixed(1)}" width="${W}" height="${Math.max(0, H - horizonY).toFixed(1)}" fill="#0c1117"/>
<g clip-path="url(#frame)">
${body}
</g>
<g fill="none" stroke="#ffe14d" stroke-opacity=".5" stroke-width="1">
<line x1="${W / 2 - 14}" y1="${H / 2}" x2="${W / 2 + 14}" y2="${H / 2}"/>
<line x1="${W / 2}" y1="${H / 2 - 14}" x2="${W / 2}" y2="${H / 2 + 14}"/>
</g>
<text x="18" y="30" fill="#ffe14d" font-family="monospace" font-size="16">${prefix}/${cone.id} @ ${(cone.pitch * 180 / Math.PI).toFixed(0)}° — ${cone.subject.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>
</svg>`;
      writeFileSync(`${OUT}/${prefix}-${cone.id}.svg`, svg);
    }
  });
});
