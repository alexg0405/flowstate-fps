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
    /**
     * The Atrium's open flank.
     *
     * Both arenas were walled to eight metres on both sides at the same height, and that
     * is the geometry that makes a room read as a trench however well it is lit: two
     * parallel walls of equal height own the frame and there is nowhere for the city to
     * be. This is now a parapet -- 1.2 m above the deck, which is under the player's eye
     * at 1.48, so they see over it -- and the flank is open.
     *
     * The wall-run surface it used to be does not just disappear: `arena-one-fin` puts
     * one back *inside* the room, where it also breaks a sightline and gives the chain
     * something to use mid-flight. Opening a flank must not cost the movement vocabulary,
     * which is the whole reason this is two edits and not one.
     */
    box('arena-one-right', [15, 2.1, -44], [1, 2.2, 22], '#22aab3', 'no-traverse'),
    box('arena-one-fin', [10, 5, -47], [1, 6, 8], '#22aab3', 'wall-run'),
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
    // The Gallery opens on the right, because `void-wall` reinforces the left. Same
    // trade as the Atrium: a parapet out, a fin in. The fin sits at z -99 to -94, which
    // is the one gap on this flank that no hostile spawns into.
    box('arena-two-right', [17, 6.1, -94], [1, 2.2, 24], '#22aab3', 'no-traverse'),
    box('arena-two-fin', [12, 9, -96.5], [1, 6, 5], '#22aab3', 'wall-run'),
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

/**
 * A mass that is only ever looked at. See `vistaBlockout.ts` for why `collision: false`
 * is the whole trick: the simulation builds no body for it, the nav bake excludes it, and
 * `WorldPresenter` draws it as a painted background mass instead of route furniture.
 */
function mass(id: string, position: Vec3, scale: Vec3, color: string, rotation: Vec3 = [0, 0, 0]): CollisionPrimitiveV2 {
  return {
    id,
    kind: 'box',
    transform: { position, rotation, scale },
    color,
    collision: false,
    surface: 'no-traverse',
    traversal: traversalFlagsFor('no-traverse', false),
    nav: navigationFlagsFor('no-traverse', false),
  };
}

/**
 * The composition, laid over the route without moving a single metre of it.
 *
 * This route is 172 m of straight line down -Z between parallel walls seven and eight
 * metres tall, with a 180-tower skyline scattered by seed starting 29 m out. The dead
 * band between the two is why the frame reads as low walls under a distant city rather
 * than as a canyon: there is nothing in the near third of the image at all.
 *
 * Every mass here is a no-collider addition. Nothing walkable moved, no spawn moved, no
 * gate moved, and `routeTraversal` and `waves` are untouched by design -- the claim the
 * blockout was built to test is that the *image* is what the level architecture caps, and
 * this is that claim applied to the shipped route at the lowest possible risk. If the
 * frames do not improve from this alone, the next step is moving geometry, and it should
 * be taken with that evidence rather than before it.
 *
 * Four movements, and the rules are the ones the blockout arrived at the hard way:
 * asymmetric flanks rather than matched pairs, a subject with sky on *both* sides rather
 * than one running off the frame edge, no horizontal foreground element (it either sits
 * across the middle of a 122-degree frame or leaves it), and one diagonal to break the
 * verticals.
 */
const whiteLineComposition: CollisionPrimitiveV2[] = [
  // 1. The canyon. Two masses two metres outside the start walls, so the first thing the
  // player sees is a hundred metres of building rather than seven metres of wall and then
  // sky. Different heights and depths, because a matched pair reads as a corridor.
  mass('canyon-left', [-26, 42, -6], [30, 120, 44], '#151d27'),
  mass('canyon-right', [26, 30, -2], [26, 96, 40], '#101822'),

  // 2. The subject, revealed coming over the bridge into the first arena. 214 m out and
  // 520 m tall, which is what it costs to have sky on both sides of it at this field of
  // view and still lose its crown off the top of a frame pitched 20 degrees up. Held
  // clear of the final arena in both axes so the route can run to its foot.
  mass('hero-spire', [-77, 242, -230], [110, 520, 110], '#151d27'),

  // 3. The gallery's open flank. One 200 m mass three metres outside the left wall and
  // nothing at all on the right, so the second arena stops being walled to the same
  // height on both sides -- which is the geometry that makes an arena read as a trench.
  mass('void-wall', [-37, 82, -95], [34, 200, 40], '#0d151d'),

  // 4. The inversion. Roofs beside and below the final arena's deck, tops just under it,
  // so a route that spent its whole length looking up ends looking down.
  mass('roof-below-a', [36, -4, -150], [40, 28, 44], '#131b24'),
  mass('roof-below-b', [62, -6, -196], [50, 24, 48], '#0f171f'),
  // And one at height on the same flank. With only the two roofs the right half of the
  // Roofline frame was an empty colour field: correct for "the city is beneath you", but
  // a frame with nothing at all in half of it has no depth to read the descent against.
  mass('roof-counterweight', [70, 26, -200], [44, 88, 44], '#101822'),

  // The diagonal. Everything above is vertical, and a frame of verticals is a fence.
  mass('sky-span', [-6, 70, -100], [200, 5, 11], '#0b1016', [0, 0.5, 0.05]),
];

/**
 * The catalogued art a collision primitive wears, derived from its own shape and
 * surface tag rather than authored twice.
 *
 * Exported because `vistaBlockout` needs a route drawn with the same materials this
 * route is drawn with: a blockout built to be compared against the game is only
 * evidence if it is made of the same thing the game is made of.
 */
export function alignedVisual(primitive: CollisionPrimitiveV2): VisualInstance | null {
  if (primitive.gateForEncounterId) return null;
  const [sx, sy, sz] = primitive.transform.scale;
  let assetId = 'environment.rooftop-platform';
  let scale: Vec3 = [sx / 4, sy / 0.42, sz / 4];
  let rotation: Vec3 = primitive.transform.rotation;
  if (primitive.id.includes('grapple') || (primitive.surface === 'no-traverse' && Math.max(sx, sy, sz) <= 4)) {
    assetId = 'environment.grapple-anchor';
    scale = [Math.max(0.7, sx * 0.45), Math.max(0.7, sy * 0.45), Math.max(0.7, sz * 0.45)];
  } else if (primitive.surface === 'no-traverse' && sy <= 4 && Math.max(sx, sz) > 4) {
    // A parapet: long, low, and deliberately not a surface. The vault barrier is the only
    // kit piece shaped like one, and it needs the same axis swap the wall-run panel does,
    // because the asset's length runs down X and a parapet's may run down either.
    assetId = 'environment.vault-barrier';
    if (sx < sz) {
      rotation = [primitive.transform.rotation[0], primitive.transform.rotation[1] + Math.PI / 2, primitive.transform.rotation[2]];
      scale = [sz / 2.4, sy / 1.05, sx / 0.5];
    } else {
      scale = [sx / 2.4, sy / 1.05, sz / 0.5];
    }
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

// Route primitives only. A 520 m spire is not a rooftop platform scaled a hundred and
// thirty times, and `WorldPresenter` has a path for exactly this case.
const collisionVisuals = defaultCollision.map(alignedVisual).filter((visual): visual is VisualInstance => visual !== null);
const defaultCollisionWithComposition: CollisionPrimitiveV2[] = [...defaultCollision, ...whiteLineComposition];
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
  collision: defaultCollisionWithComposition,
  visuals: [...collisionVisuals, ...routeVisuals],
  lights: cyberDuskLights,
  environmentPresetId: DEFAULT_ENVIRONMENT_PRESET_ID,
  assetCatalogVersion: DEFAULT_ASSET_CATALOG_VERSION,
  primitives: defaultCollisionWithComposition,
  /**
   * Three rooms, each of which asks a different question, and each of which has more
   * than one answer to give before it opens.
   *
   * - **Atrium** teaches the pair -- one hostile closing, one holding distance -- and
   *   then teaches that a room going quiet is not a room being over.
   * - **Gallery** introduces the plate head-on with a marksman on each flank, so
   *   standing still to grind the shield down is the losing line. Its second wave puts a
   *   second plate and a crowd behind it, so the flank that solves the shield is the one
   *   under fire.
   * - **Roofline** is the finale and the only room that puts **eight** on the deck at
   *   once: a bulwark, five brawlers and two marksmen, which is what the heavy swing's
   *   160-degree sweep was built for.
   *
   * Twenty-eight hostiles across seven waves, where this route used to hold nine in
   * three static groups. `wave` on a spawn is what makes that affordable -- the peak
   * concurrent count is eight, not twenty-eight, so the volume is in the room's length
   * rather than in the frame budget.
   *
   * `rotationY` on a bulwark is load bearing: it decides which way the plate starts, and
   * the profile's turn rate decides how long it takes to bring it round. The Gallery's
   * second plate starts turned away on purpose.
   */
  spawns: [
    { id: 'player-start', kind: 'player', position: [0, 1.1, 8], rotationY: 0 },

    // Atrium: teaches the pair, then teaches that a room is not over when it goes quiet.
    /**
     * Moved from [-6, 3, -44], which was inside `cover-one-a`.
     *
     * That block spans x -7 to -5 and z -44.5 to -39.5, so the Atrium's first brawler was
     * spawning in the dead centre of a solid vault barrier. Found by an invariant added
     * while opening the arena flanks, not by playing -- a bot inside a collider is a bot
     * that never joins the fight, and nothing in the game reports it.
     */
    { id: 'atrium-brawler-a', kind: 'bot-aggressive', position: [-9, 3, -47], rotationY: 0, encounterId: 'arena-1' },
    { id: 'atrium-brawler-b', kind: 'bot-aggressive', position: [6, 3, -46], rotationY: 0, encounterId: 'arena-1' },
    { id: 'atrium-marksman-a', kind: 'bot-ranged', position: [-11, 3, -51], rotationY: 0, encounterId: 'arena-1' },
    { id: 'atrium-brawler-c', kind: 'bot-aggressive', position: [-9, 3, -40], rotationY: 0, encounterId: 'arena-1', wave: 1 },
    { id: 'atrium-brawler-d', kind: 'bot-aggressive', position: [0, 3, -52], rotationY: 0, encounterId: 'arena-1', wave: 1 },
    { id: 'atrium-brawler-e', kind: 'bot-aggressive', position: [10, 3, -40], rotationY: 0, encounterId: 'arena-1', wave: 1 },
    { id: 'atrium-marksman-b', kind: 'bot-ranged', position: [12, 3, -52], rotationY: 0, encounterId: 'arena-1', wave: 1 },

    // Gallery: the plate head-on with a marksman on each flank, then the same puzzle
    // with a crowd in it, so the flank that solves the shield is the one under fire.
    { id: 'gallery-bulwark-a', kind: 'bot-bulwark', position: [1, 7, -95], rotationY: 0, encounterId: 'arena-2' },
    { id: 'gallery-marksman-a', kind: 'bot-ranged', position: [-13, 7, -97], rotationY: 0, encounterId: 'arena-2' },
    { id: 'gallery-marksman-b', kind: 'bot-ranged', position: [13, 7, -92], rotationY: 0, encounterId: 'arena-2' },
    { id: 'gallery-bulwark-b', kind: 'bot-bulwark', position: [-4, 7, -88], rotationY: 2.4, encounterId: 'arena-2', wave: 1 },
    { id: 'gallery-brawler-a', kind: 'bot-aggressive', position: [-14, 7, -90], rotationY: 0, encounterId: 'arena-2', wave: 1 },
    { id: 'gallery-brawler-b', kind: 'bot-aggressive', position: [14, 7, -100], rotationY: 0, encounterId: 'arena-2', wave: 1 },
    { id: 'gallery-brawler-c', kind: 'bot-aggressive', position: [3, 7, -103], rotationY: 0, encounterId: 'arena-2', wave: 1 },
    { id: 'gallery-marksman-c', kind: 'bot-ranged', position: [11, 7, -103], rotationY: 0, encounterId: 'arena-2', wave: 1 },

    // Roofline: the finale, and the only room that puts eight on the deck at once.
    { id: 'roof-brawler-a', kind: 'bot-aggressive', position: [-8, 11.5, -146], rotationY: 0, encounterId: 'arena-3' },
    { id: 'roof-brawler-b', kind: 'bot-aggressive', position: [8, 11.5, -146], rotationY: 0, encounterId: 'arena-3' },
    { id: 'roof-brawler-c', kind: 'bot-aggressive', position: [0, 11.5, -155], rotationY: 0, encounterId: 'arena-3' },
    { id: 'roof-marksman-a', kind: 'bot-ranged', position: [-11, 11.5, -156], rotationY: 0, encounterId: 'arena-3' },
    { id: 'roof-marksman-b', kind: 'bot-ranged', position: [11, 11.5, -156], rotationY: 0, encounterId: 'arena-3' },
    { id: 'roof-bulwark', kind: 'bot-bulwark', position: [0, 11.5, -142], rotationY: 0, encounterId: 'arena-3', wave: 1 },
    { id: 'roof-brawler-d', kind: 'bot-aggressive', position: [-12, 11.5, -142], rotationY: 0, encounterId: 'arena-3', wave: 1 },
    { id: 'roof-brawler-e', kind: 'bot-aggressive', position: [12, 11.5, -142], rotationY: 0, encounterId: 'arena-3', wave: 1 },
    { id: 'roof-brawler-f', kind: 'bot-aggressive', position: [-4, 11.5, -158], rotationY: 0, encounterId: 'arena-3', wave: 1 },
    { id: 'roof-brawler-g', kind: 'bot-aggressive', position: [4, 11.5, -158], rotationY: 0, encounterId: 'arena-3', wave: 1 },
    { id: 'roof-brawler-h', kind: 'bot-aggressive', position: [-12, 11.5, -152], rotationY: 0, encounterId: 'arena-3', wave: 1 },
    { id: 'roof-marksman-c', kind: 'bot-ranged', position: [12, 11.5, -152], rotationY: 0, encounterId: 'arena-3', wave: 1 },
    { id: 'roof-marksman-d', kind: 'bot-ranged', position: [0, 11.5, -159], rotationY: 0, encounterId: 'arena-3', wave: 1 },
  ],
  encounters: [
    { id: 'arena-1', label: 'Atrium', checkpoint: [0, 3.1, -34], requiredBotIds: ['atrium-brawler-a', 'atrium-brawler-b', 'atrium-marksman-a', 'atrium-brawler-c', 'atrium-brawler-d', 'atrium-brawler-e', 'atrium-marksman-b'] },
    { id: 'arena-2', label: 'Gallery', checkpoint: [0, 6.1, -84], requiredBotIds: ['gallery-bulwark-a', 'gallery-marksman-a', 'gallery-marksman-b', 'gallery-bulwark-b', 'gallery-brawler-a', 'gallery-brawler-b', 'gallery-brawler-c', 'gallery-marksman-c'] },
    { id: 'arena-3', label: 'Roofline', checkpoint: [0, 11.1, -137], requiredBotIds: ['roof-brawler-a', 'roof-brawler-b', 'roof-brawler-c', 'roof-marksman-a', 'roof-marksman-b', 'roof-bulwark', 'roof-brawler-d', 'roof-brawler-e', 'roof-brawler-f', 'roof-brawler-g', 'roof-brawler-h', 'roof-marksman-c', 'roof-marksman-d'] },
  ],
  offMeshLinks: [
    { id: 'link-arena-one-rise', start: [0, 3, -55], end: [0, 4, -61], bidirectional: true, action: 'jump' },
    { id: 'link-gallery-rise', start: [0, 6, -105], end: [0, 10, -118], bidirectional: false, action: 'vault' },
  ],
  /**
   * Where the route wants the view, now that there is something composed to look at.
   *
   * Placed at *approaches* rather than inside the arenas. The nudge disarms with a
   * hostile inside 45 m, which is correct -- nothing moves the aim during a fight -- so a
   * hint in the middle of the Gallery would almost never fire. These sit on the run-up to
   * each room, where the player is moving and the room ahead is still quiet.
   *
   * Every pitch here is at or under `lookNudge.maxPitchOffset`, so the nudge delivers all
   * of what was authored and the player sees the composition that was composed. The
   * blockout deliberately asks for more than the cap in two places to test where the
   * ceiling bites; the shipped route should not have to guess.
   */
  vistaHints: [
    { id: 'hint-canyon', at: [0, 1.1, 4], radius: 12, yaw: 0, pitch: (16 * Math.PI) / 180 },
    { id: 'hint-bridge', at: [0, 4, -28], radius: 12, yaw: 0, pitch: (18 * Math.PI) / 180 },
    // Pulled back from z = -76 and tightened to 12 m: at the original placement the zone
    // reached within 12.9 m of a Gallery spawn, and a hint the nudge disarms inside is a
    // hint that never fires.
    { id: 'hint-gallery-approach', at: [0, 4.5, -70], radius: 12, yaw: 0, pitch: (18 * Math.PI) / 180 },
    // Also pulled back: the Roofline's bulwark spawns at z = -142, and a 16 m zone at
    // z = -128 reached 14 m of it.
    { id: 'hint-roofline', at: [0, 11, -122], radius: 12, yaw: 0, pitch: (18 * Math.PI) / 180 },
  ],
  exit: [0, 12, -164],
};

export function cookLevel(level: LevelDocument): RuntimeLevelV2 {
  return structuredClone({ ...migrateLevelDocument(level), bakedAt: new Date().toISOString() });
}
