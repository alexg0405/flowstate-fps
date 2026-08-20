import type { CollisionPrimitiveV2, LevelDocument, LevelDocumentV2, LightInstance, RuntimeLevelV2, Vec3, VisualInstance } from '../contracts';
import { DEFAULT_ASSET_CATALOG_VERSION, DEFAULT_ENVIRONMENT_PRESET_ID, migrateLevelDocument, navigationFlagsFor, traversalFlagsFor } from './migrations';

function box(id: string, position: Vec3, scale: Vec3, color: string, surface: CollisionPrimitiveV2['surface'] = 'default'): CollisionPrimitiveV2 {
  return {
    id,
    kind: 'box',
    transform: { position, rotation: [0, 0, 0], scale },
    color,
    collision: true,
    surface,
    traversal: traversalFlagsFor(surface, true),
    nav: navigationFlagsFor(surface, true),
  };
}

const RAMP_THICKNESS = 0.8;

/**
 * A ramp that meets the two decks it joins, derived from where they are rather than
 * authored as a rotation and hoped for.
 *
 * Both ramps on this route were previously written as a centre, a size and a hand-set
 * `rotationX`, and both had the sign the wrong way round: `rise-a` sloped *down* away
 * from the start floor, so its walkable face was 2.9 m in the air at the near end and
 * 0.4 m at the far end, leaving an eight-metre hole between the start floor and the
 * bridge. Walking forward from the spawn fell through it and died at tick 263 -- on
 * this commit's parent as well, tick for tick, so the route has never been walkable.
 * Nothing caught it because nothing walked it: the completion e2e enters through
 * `?scene=finish`.
 *
 * `near` is the end with the larger Z, which is the end the player arrives from.
 * `routeIsWalkable` in `tests/routeTraversal.test.ts` now holds the whole thing.
 */
function rampBetween(
  id: string,
  near: { z: number; y: number },
  far: { z: number; y: number },
  width: number,
  color = '#d9ddd8',
): CollisionPrimitiveV2 {
  const run = near.z - far.z;
  const rise = far.y - near.y;
  const angle = Math.atan2(rise, run);
  const length = Math.hypot(run, rise);
  // The transform positions the box's centre, and what has to line up is the middle of
  // its top face, so back off half the thickness along the rotated up axis.
  const position: Vec3 = [
    0,
    (near.y + far.y) / 2 - (RAMP_THICKNESS / 2) * Math.cos(angle),
    (near.z + far.z) / 2 - (RAMP_THICKNESS / 2) * Math.sin(angle),
  ];
  return {
    id,
    kind: 'ramp',
    transform: { position, rotation: [angle, 0, 0], scale: [width, RAMP_THICKNESS, length] },
    color,
    collision: true,
    surface: 'default',
    traversal: traversalFlagsFor('default', true),
    nav: navigationFlagsFor('default', true),
  };
}

const defaultCollision: CollisionPrimitiveV2[] = [
    box('start-floor', [0, -0.5, 0], [18, 1, 24], '#f2f0e8'),
    box('start-wall-left', [-9, 3, 0], [1, 7, 24], '#d8ddd8', 'wall-run'),
    box('start-wall-right', [9, 3, 0], [1, 7, 24], '#d8ddd8', 'wall-run'),
    box('vault-a', [-3, 0.75, -2], [4, 1.5, 1.3], '#e63746', 'vault'),
    box('vault-b', [3, 1.1, -8], [3, 2.2, 1.2], '#e63746', 'mantle'),
    rampBetween('rise-a', { z: -12, y: 0 }, { z: -20.5, y: 3.5 }, 8),
    box('bridge-a', [0, 3, -27], [9, 1, 13], '#f2f0e8'),
    box('wallrun-a', [-6, 6, -27], [1, 6, 13], '#22aab3', 'wall-run'),
    box('arena-one', [0, 1.5, -44], [30, 1, 22], '#f2f0e8'),
    box('arena-one-left', [-15, 5, -44], [1, 8, 22], '#d8ddd8', 'wall-run'),
    box('arena-one-right', [15, 5, -44], [1, 8, 22], '#d8ddd8', 'wall-run'),
    box('cover-one-a', [-6, 3, -42], [2, 3, 5], '#e63746', 'vault'),
    box('cover-one-b', [7, 3.25, -49], [3, 3.5, 2], '#e63746', 'mantle'),
    { ...box('gate-one', [0, 5, -55.5], [29, 7, 0.5], '#e63746', 'no-traverse'), gateForEncounterId: 'arena-1' },
    box('step-one', [0, 3.5, -58], [10, 1, 5], '#f2f0e8'),
    box('run-two', [0, 3.5, -70], [12, 1, 19], '#f2f0e8'),
    box('run-two-wall', [6, 8, -70], [1, 8, 19], '#22aab3', 'wall-run'),
    box('run-two-gap-platform', [-7, 5.5, -78], [7, 1, 7], '#f2f0e8'),
    box('grapple-overhead-a', [0, 14, -69], [16, 1.2, 2], '#17222b', 'no-traverse'),
    box('grapple-overhead-b', [-8, 12, -77], [2, 2, 8], '#22aab3', 'no-traverse'),
    box('grapple-corner-anchor', [10, 13, -82], [3, 3, 3], '#e63746', 'no-traverse'),
    box('arena-two', [0, 5.5, -94], [34, 1, 24], '#f2f0e8'),
    box('arena-two-cover-a', [-8, 7, -92], [2, 3, 8], '#e63746', 'vault'),
    box('arena-two-cover-b', [7, 7.5, -97], [4, 4, 2], '#e63746', 'mantle'),
    box('arena-two-left', [-17, 9, -94], [1, 8, 24], '#d8ddd8', 'wall-run'),
    box('arena-two-right', [17, 9, -94], [1, 8, 24], '#d8ddd8', 'wall-run'),
    { ...box('gate-two', [0, 9, -106.5], [33, 7, 0.5], '#e63746', 'no-traverse'), gateForEncounterId: 'arena-2' },
    rampBetween('rise-three', { z: -106, y: 6 }, { z: -116, y: 10.5 }, 9),
    box('sky-route', [0, 10, -126], [10, 1, 20], '#f2f0e8'),
    box('sky-wall-left', [-5.5, 14, -126], [1, 8, 20], '#22aab3', 'wall-run'),
    box('final-arena', [0, 10, -148], [28, 1, 24], '#f2f0e8'),
    box('final-cover-a', [-6, 12, -146], [3, 4, 3], '#e63746', 'mantle'),
    box('final-cover-b', [7, 11.25, -151], [5, 2.5, 2], '#e63746', 'vault'),
    { ...box('gate-three', [0, 14, -160], [27, 7, 0.5], '#e63746', 'no-traverse'), gateForEncounterId: 'arena-3' },
    box('finish', [0, 11, -164], [8, 2, 3], '#22aab3'),
];

function alignedVisual(primitive: CollisionPrimitiveV2): VisualInstance | null {
  if (primitive.gateForEncounterId) return null;
  const [sx, sy, sz] = primitive.transform.scale;
  let assetId = 'environment.rooftop-platform';
  let scale: Vec3 = [sx / 4, sy / 0.42, sz / 4];
  let rotation: Vec3 = primitive.transform.rotation;
  if (primitive.id.includes('grapple') || (primitive.surface === 'no-traverse' && Math.max(sx, sy, sz) <= 4)) {
    assetId = 'environment.grapple-anchor';
    scale = [Math.max(0.7, sx * 0.45), Math.max(0.7, sy * 0.45), Math.max(0.7, sz * 0.45)];
  } else if (primitive.surface === 'wall-run') {
    assetId = 'environment.wallrun-panel';
    if (sx < sz) {
      rotation = [primitive.transform.rotation[0], primitive.transform.rotation[1] + Math.PI / 2, primitive.transform.rotation[2]];
      scale = [sz / 4, sy / 2.8, sx / 0.24];
    } else {
      scale = [sx / 4, sy / 2.8, sz / 0.24];
    }
  } else if (primitive.surface === 'vault' || primitive.surface === 'mantle') {
    assetId = 'environment.vault-barrier';
    scale = [sx / 2.4, sy / 1.05, sz / 0.5];
  }
  return {
    id: `visual-${primitive.id}`,
    assetId,
    transform: { position: primitive.transform.position, rotation, scale },
    materialVariantId: primitive.surface,
    // Decks are large horizontal slabs under an overhead sun, so what they cast falls
    // on themselves. They still receive. Uprights -- walls, barriers, anchors -- are
    // what actually throws a readable shadow, and they keep casting.
    castShadow: assetId !== 'environment.rooftop-platform',
    receiveShadow: true,
    collisionAlignmentId: primitive.id,
    gateVisibilityBindingId: primitive.gateForEncounterId,
  };
}

const collisionVisuals = defaultCollision.map(alignedVisual).filter((visual): visual is VisualInstance => visual !== null);
const routeVisuals: VisualInstance[] = [
  { id: 'visual-sign-atrium', assetId: 'environment.route-sign', transform: { position: [-5, 5.4, -33], rotation: [0, 0.15, 0], scale: [1.2, 1.2, 1.2] }, castShadow: true, receiveShadow: true },
  { id: 'visual-sign-gallery', assetId: 'environment.route-sign', transform: { position: [5.5, 8.6, -83], rotation: [0, -0.2, 0], scale: [1.2, 1.2, 1.2] }, castShadow: true, receiveShadow: true },
  { id: 'visual-sign-roofline', assetId: 'environment.route-sign', transform: { position: [-4.5, 13.7, -136], rotation: [0, 0.12, 0], scale: [1.2, 1.2, 1.2] }, castShadow: true, receiveShadow: true },
];

const cyberDuskLights: LightInstance[] = [
  { id: 'light-start-cyan', kind: 'point', transform: { position: [-6, 3.2, 4], rotation: [0, 0, 0], scale: [1, 1, 1] }, color: '#45edff', intensity: 18, range: 13, castShadow: false },
  { id: 'light-rise-magenta', kind: 'spot', transform: { position: [4, 7, -18], rotation: [-0.8, 0.2, 0], scale: [1, 1, 1] }, color: '#ff4477', intensity: 26, range: 22, coneAngle: 0.62, penumbra: 0.7, castShadow: false },
  { id: 'light-atrium-cyan', kind: 'point', transform: { position: [-11, 7, -44], rotation: [0, 0, 0], scale: [1, 1, 1] }, color: '#4feeff', intensity: 20, range: 16, castShadow: false },
  { id: 'light-atrium-amber', kind: 'point', transform: { position: [11, 6, -49], rotation: [0, 0, 0], scale: [1, 1, 1] }, color: '#ffad52', intensity: 16, range: 14, castShadow: false },
  { id: 'light-grapple', kind: 'point', transform: { position: [0, 13, -73], rotation: [0, 0, 0], scale: [1, 1, 1] }, color: '#50f5ff', intensity: 24, range: 18, castShadow: false },
  { id: 'light-gallery', kind: 'spot', transform: { position: [0, 17, -94], rotation: [-1.25, 0, 0], scale: [1, 1, 1] }, color: '#ff3e71', intensity: 30, range: 28, coneAngle: 0.72, penumbra: 0.75, castShadow: false },
  { id: 'light-skyroute', kind: 'point', transform: { position: [-4, 15, -126], rotation: [0, 0, 0], scale: [1, 1, 1] }, color: '#45e7ff', intensity: 20, range: 17, castShadow: false },
  { id: 'light-finish', kind: 'spot', transform: { position: [0, 19, -160], rotation: [-1.3, 0, 0], scale: [1, 1, 1] }, color: '#ffbe72', intensity: 32, range: 25, coneAngle: 0.58, penumbra: 0.65, castShadow: false },
];

export const defaultLevel: LevelDocumentV2 = {
  schemaVersion: 2,
  id: 'white-line',
  name: 'White Line',
  units: 'meters',
  collision: defaultCollision,
  visuals: [...collisionVisuals, ...routeVisuals],
  lights: cyberDuskLights,
  environmentPresetId: DEFAULT_ENVIRONMENT_PRESET_ID,
  assetCatalogVersion: DEFAULT_ASSET_CATALOG_VERSION,
  primitives: defaultCollision,
  /**
   * Three arenas that ask different questions, rather than two bots each.
   *
   * - Atrium teaches the pair: one hunter holding distance, one closing.
   * - Gallery introduces the bulwark head-on, with a marksman on each flank so
   *   standing still to grind the plate down is the losing line.
   * - Roofline stacks a bulwark and a brawler in front and a marksman behind, so the
   *   flank that solves the plate is also the one that walks into the rest of them.
   *
   * `rotationY` on a bulwark is load bearing: it decides which way the plate starts,
   * and the profile's turn rate decides how long it takes to bring it round.
   */
  spawns: [
    { id: 'player-start', kind: 'player', position: [0, 1.1, 8], rotationY: 0 },
    { id: 'bot-a', kind: 'bot-ranged', position: [-8, 3, -45], rotationY: 0, encounterId: 'arena-1' },
    { id: 'bot-b', kind: 'bot-aggressive', position: [8, 3, -47], rotationY: 0, encounterId: 'arena-1' },
    { id: 'bot-c', kind: 'bot-ranged', position: [-13, 7, -97], rotationY: 0, encounterId: 'arena-2' },
    { id: 'bot-d', kind: 'bot-bulwark', position: [1, 7, -95], rotationY: 0, encounterId: 'arena-2' },
    { id: 'bot-g', kind: 'bot-ranged', position: [13, 7, -92], rotationY: 0, encounterId: 'arena-2' },
    { id: 'bot-e', kind: 'bot-ranged', position: [-7, 11.5, -154], rotationY: 0, encounterId: 'arena-3' },
    { id: 'bot-f', kind: 'bot-aggressive', position: [8, 11.5, -146], rotationY: 0, encounterId: 'arena-3' },
    { id: 'bot-h', kind: 'bot-bulwark', position: [-3, 11.5, -145], rotationY: 0, encounterId: 'arena-3' },
    { id: 'bot-i', kind: 'bot-aggressive', position: [10, 11.5, -153], rotationY: 0, encounterId: 'arena-3' },
  ],
  encounters: [
    { id: 'arena-1', label: 'Atrium', checkpoint: [0, 3.1, -34], requiredBotIds: ['bot-a', 'bot-b'] },
    { id: 'arena-2', label: 'Gallery', checkpoint: [0, 6.1, -84], requiredBotIds: ['bot-c', 'bot-d', 'bot-g'] },
    { id: 'arena-3', label: 'Roofline', checkpoint: [0, 11.1, -137], requiredBotIds: ['bot-e', 'bot-f', 'bot-h', 'bot-i'] },
  ],
  offMeshLinks: [
    { id: 'link-arena-one-rise', start: [0, 3, -55], end: [0, 4, -61], bidirectional: true, action: 'jump' },
    { id: 'link-gallery-rise', start: [0, 6, -105], end: [0, 10, -118], bidirectional: false, action: 'vault' },
  ],
  exit: [0, 12, -164],
};

export function cookLevel(level: LevelDocument): RuntimeLevelV2 {
  return structuredClone({ ...migrateLevelDocument(level), bakedAt: new Date().toISOString() });
}
