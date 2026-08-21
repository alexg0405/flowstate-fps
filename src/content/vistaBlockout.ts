import type { CollisionPrimitiveV2, LevelDocumentV2, LightInstance, Vec3, VisualInstance, VistaHint } from '../contracts';
import { alignedVisual } from './defaultLevel';
import { DEFAULT_ASSET_CATALOG_VERSION, DEFAULT_ENVIRONMENT_PRESET_ID, navigationFlagsFor, traversalFlagsFor } from './migrations';

/**
 * A hero vista, built to answer one question before anything else is spent.
 *
 * The art direction wants "you are tiny, the city is enormous". White Line is a slot
 * between two parallel walls with a skyline over the top of it, and no renderer can
 * fix that: if two corridor walls own most of the frame, the image reads as a corridor
 * however well those walls are lit. The claim this level exists to test is that the
 * *level architecture*, not the renderer, is now what caps the look.
 *
 * So this is not content. It is a fifteen-second traversal whose only job is to be
 * screenshotted next to the reference. It ships behind `?scene=vista`, it holds no
 * hostiles, and if it does not read closer to the reference than White Line does then
 * the diagnosis was wrong and the next pass belongs somewhere else.
 *
 * ## The three things it does differently
 *
 * **Playable width and visible width are separated.** Every space here is as narrow as
 * White Line's or narrower -- the slot is 7 m, the ledge is 5 m -- while the *visible*
 * world runs a hundred and fifty metres out and two hundred up. Scale is bought in the
 * part of the frame that costs nothing: masses beyond the playable bounds carry no
 * collider, no nav, and no interior.
 *
 * **The route turns.** White Line runs down -Z for a hundred and seventy metres without
 * a single change of heading, so nothing can ever be *revealed*: whatever is ahead has
 * been ahead since the spawn. Here the slot dead-ends into a wall and turns ninety
 * degrees left, and the tower is not in frame at all until it turns.
 *
 * **One side of the street is open.** Both of White Line's arenas are walled on both
 * flanks at the same height, which is the geometry that makes an arena read as a
 * trench. The street is a 40 m cliff on the left and a 3.2 m parapet on the right, so
 * half the frame is city instead of wall.
 *
 * ## Coordinates
 *
 * The slot runs down -Z from the spawn, the turn is at `z = -24`, and everything after
 * it runs down -X on the `z = -24` centreline. The composition masses sit past the
 * parapet in -Z. `y = 0` is the slot floor; the city's own ground plane is at -18,
 * which is where the background masses are footed so they read as standing on it.
 */

function box(
  id: string,
  position: Vec3,
  scale: Vec3,
  color: string,
  surface: CollisionPrimitiveV2['surface'] = 'default',
): CollisionPrimitiveV2 {
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

/**
 * A mass that is only ever looked at.
 *
 * `collision: false` is what separates the two halves of this level, and it is load
 * bearing in three places at once: the simulation skips a primitive without it when it
 * builds static bodies, the nav bake excludes it, and `WorldPresenter` reads it as the
 * signal to draw the primitive as a painted background mass rather than as route
 * furniture. That is the whole trick that makes a 200 m tower affordable -- it is six
 * triangles' worth of decision and no gameplay surface at all.
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

const RAMP_THICKNESS = 0.8;

/**
 * A ramp up the X axis, derived from the two decks it joins.
 *
 * `defaultLevel`'s `rampBetween` does this about the Z axis and cannot be reused: it
 * hard-codes `x = 0` for the centre and reads the run off Z, because White Line never
 * changes heading. This route does, so the same arithmetic is needed one axis over.
 *
 * A cuboid rotated about Z by `angle` puts the middle of its top face at
 * `C + (t·cos - (h/2)·sin, t·sin + (h/2)·cos, 0)` for `t` along its own length. Solving
 * the two ends against the decks gives `length = hypot(run, rise)` and
 * `angle = atan2(-rise, run)` -- the sign matters and is the thing that was wrong twice
 * on the Z-axis version, so `tests/vistaBlockout.test.ts` holds both ends of it.
 *
 * `near` is the end with the larger X, which is the end the player arrives from.
 */
function rampAlongX(
  id: string,
  near: { x: number; y: number },
  far: { x: number; y: number },
  width: number,
  color = '#d9ddd8',
): CollisionPrimitiveV2 {
  const run = near.x - far.x;
  const rise = far.y - near.y;
  const angle = Math.atan2(-rise, run);
  const length = Math.hypot(run, rise);
  const position: Vec3 = [
    (near.x + far.x) / 2 + (RAMP_THICKNESS / 2) * Math.sin(angle),
    (near.y + far.y) / 2 - (RAMP_THICKNESS / 2) * Math.cos(angle),
    -24,
  ];
  return {
    id,
    kind: 'ramp',
    transform: { position, rotation: [0, 0, angle], scale: [length, RAMP_THICKNESS, width] },
    color,
    collision: true,
    surface: 'default',
    traversal: traversalFlagsFor('default', true),
    nav: navigationFlagsFor('default', true),
  };
}

/**
 * The playable route: seven metres wide at its widest ambition, and never the subject
 * of a single shot.
 */
const route: CollisionPrimitiveV2[] = [
  // --- The slot. Deliberately claustrophobic, and the reason the reveal lands. Seven
  // metres between walls that go up twenty-six leaves a sky slot about fifteen degrees
  // wide, so the player arrives at the turn having seen almost none of the city.
  box('slot-floor', [0, -0.5, -8], [7, 1, 24], '#f2f0e8'),
  box('slot-wall-left', [-3.5, 13, -8], [1, 26, 24], '#d8ddd8', 'wall-run'),
  box('slot-wall-right', [3.5, 13, -8], [1, 26, 24], '#d8ddd8', 'wall-run'),

  // --- The street, which the slot T-junctions into. Eighteen metres wide, and
  // asymmetric on purpose: a forty-metre cliff on the left, a waist-high parapet on the
  // right. The parapet is the single cheapest line in this file -- it is what stops the
  // street being a trench and hands half the frame to the city instead.
  //
  // There was a turn pad here with a twenty-six-metre wall across the end of it, on the
  // theory that a dead end is what forces the ninety-degree turn. Projecting the reveal
  // showed what that actually does: the wall stands nine metres to the player's right,
  // fills the right half of the frame from top to bottom, and closes off the one flank
  // the whole composition was built to open. The reveal was a wall.
  //
  // So there is no turn pad. The slot runs into the street, and what stops the player is
  // the parapet -- which they can see over. The city arrives at the same instant the
  // route runs out, and the only way on is left, which is where the tower is.
  box('street-floor', [-28.5, -0.5, -24], [73, 1, 18], '#f2f0e8'),
  // Broken where the slot enters, so the mouth is not walled shut.
  box('street-cliff-left', [-34.25, 20, -15], [61.5, 40, 1], '#d8ddd8', 'wall-run'),
  box('street-parapet-right', [-28.5, 1.6, -33], [73, 3.2, 1], '#22aab3', 'no-traverse'),
  // Closes the wrong way out of the junction, four metres past the slot's right edge.
  box('street-end-wall', [8, 13, -24], [1, 26, 18], '#d8ddd8', 'wall-run'),

  // --- Up, out and over. A ramp to six metres, a five-metre ledge, a six-metre gap
  // with a wall-run panel down one side, and a balcony that looks back at the tower.
  rampAlongX('street-rise', { x: -65, y: 0 }, { x: -79, y: 6 }, 9),
  box('ledge-floor', [-85, 5.5, -24], [12, 1, 5], '#f2f0e8'),
  box('ledge-wall-right', [-85, 9, -27], [12, 6, 1], '#22aab3', 'wall-run'),
  box('gap-wall-right', [-94, 9.5, -27], [6, 7, 1], '#22aab3', 'wall-run'),
  box('balcony-floor', [-101, 5.5, -24], [8, 1, 7], '#f2f0e8'),

  // --- A room to stand in at the end, so the composition can be judged from a stop as
  // well as at speed. Walled high on the cliff side, low on the city side, same rule as
  // the street.
  box('overlook-floor', [-116, 5.5, -24], [22, 1, 18], '#f2f0e8'),
  box('overlook-cliff-left', [-116, 10, -15], [22, 8, 1], '#d8ddd8', 'wall-run'),
  // Waist high, and that is a measurement rather than a style. At 2.2 m tall its top sat
  // 0.7 m *above* the eye of a player standing on this deck, so the one shot whose whole
  // subject is below the horizon was looking at the inside face of a wall.
  box('overlook-parapet-right', [-116, 6.6, -33], [22, 1.2, 1], '#22aab3', 'no-traverse'),
  box('overlook-cover', [-112, 7.5, -27], [3, 3, 3], '#e63746', 'mantle'),
  box('finish', [-129.5, 6.5, -24], [6, 2, 3], '#22aab3'),
];

/**
 * The composition. Six masses, no colliders, and the only reason this level exists.
 *
 * These are placed against a camera cone rather than against a plan view. First person
 * cannot guarantee an orientation, but route geometry can make one overwhelmingly
 * likely: a player leaving a seven-metre slot that dead-ends left is looking down -X
 * from about `(0, 1.6, -24)`, and every number below is chosen for what it does in
 * *that* frame. Somewhere behind the player these masses are an unresolved mess, and
 * that is the correct trade -- probable angles are what have to be beautiful.
 *
 * Three depths, which is the structure the reference is built on:
 *
 * - **Foreground**, near-black, framing, 10-25% of the frame: `street-arch` across the
 *   top and `street-fin` down one edge.
 * - **Midground**, the subject: `hero-tower`, at 74 m and 200 m tall, so it runs from
 *   the horizon clean out of the top of the frame. Its bottom is cut off by the arch,
 *   which is what sells the height -- a mass whose base and crown are both in frame is
 *   a model of a building, not a building.
 * - **Background**, enormous and simple: two slabs and a block that give the far
 *   distance a silhouette, plus a bridge crossing behind the tower to break the
 *   verticals with one hard diagonal.
 */
const composition: CollisionPrimitiveV2[] = [
  // There is no foreground arch, and that is a finding rather than an omission.
  //
  // The composition brief asked for "a black overhang across the upper 25% of the
  // screen", which is what the reference does with its dark foliage. Three positions
  // were tried and measured. At 43 m with its underside at 12 m it framed the top of a
  // *level* frame and cut straight across the middle of the pitched one. Brought in to
  // 24 m and raised to 20 m it capped the pitched frame on paper and read as a black
  // slab hanging in the middle of the image, because a mass spanning an 18 m street at
  // 24 m distance subtends fifty degrees of a 122-degree field. Pushed far enough away
  // to be small it left the frame entirely.
  //
  // A horizontal foreground element does not survive this camera. The framing here is
  // therefore vertical -- the cliff down one edge and the tower's own mass down the
  // other -- with the diagonal of `sky-bridge` doing the one job an overhang would have
  // done, which is to break the verticals. If the overhang matters more than the field
  // of view does, the field of view is the thing to change.

  // Midground. The subject, and sized against the camera rather than against the
  // reference image, because the two want different things. `settings.fov` is 92 --
  // which in three is the *vertical* angle, so the horizontal field is about 122
  // degrees, and a mass sized off a photograph reads as a distant slab in it.
  //
  // Two passes got this wrong in opposite directions. Sized for a photograph it was a
  // fifth of the frame wide. Brought in to eighty metres to fix that, it grew until its
  // far side ran off the right edge -- so it stopped being a subject and became the
  // frame's right wall, with the cliff as the left wall and a slot between them. Which
  // is a corridor.
  //
  // What the reference actually does is put sky on *both* sides of its subject. That
  // needs distance, and distance has to be paid for in size: 110 m across and 480 m
  // tall, at 173 m. It reads 22 degrees right of the heading, 35 degrees wide, and its
  // crown is at 70 -- past the top of a frame pitched 22 up, so the eye runs off it and
  // never finds the end. Absurd as a building and free as a box: no collider, no nav,
  // no interior.
  mass('hero-tower', [-160, 222, -92], [110, 480, 110], '#151d27'),

  // Background, and deliberately sparse. The first pass put a slab on each flank and a
  // block behind, which fenced the frame in at large scale and recreated at two hundred
  // metres exactly the canyon the street had just stopped being. The reference isolates
  // its subject against an open field of colour, so there are two masses here rather
  // than four, both well behind the tower, both leaving sky between them.
  mass('far-slab', [-290, 110, -150], [64, 256, 56], '#0d151d'),
  mass('mid-block', [-236, 34, -46], [40, 104, 40], '#1a1f26'),
  mass('sky-bridge', [-120, 78, -74], [170, 4, 10], '#0b1016', [0, 0.55, 0.05]),

  // There are no roofs below the overlook, and the reason is worth writing down.
  //
  // The composition brief's fourth chamber inverts the image: the route spends its length
  // with the city above it, and ends above the city. Three roof masses were placed under
  // the overlook to do that, and they landed inside `hero-tower` -- because a mass big
  // enough to own a 122-degree frame is 110 m across and 480 m tall, and this route is
  // only 130 m long. The tower's footprint now covers the end of it.
  //
  // Shrinking the tower would cost the two frames that work. So the fourth shot is the
  // other payoff available from standing at its foot: look *up* it. The inversion needs
  // the route to end somewhere the tower is not, which is a routing decision about where
  // White Line goes rather than a number in this file, and it has not been made.
  // There was a `street-fin` here -- a 24 m near-black blade beside the street mouth,
  // the "one palm or sign foreground silhouette" the composition brief asked for. At the
  // authored pitch it stopped being a frame and became a fifth mass standing in the
  // middle of the only gap the other four leave. The cliff and the arch already frame
  // this shot on two sides; a third framing element had nothing left to frame.
];

const blockoutCollision: CollisionPrimitiveV2[] = [...route, ...composition];

/**
 * Route primitives get the catalogued art `defaultLevel` gives them, because that art
 * is what carries the face painting and the surface accents -- a blockout drawn with
 * different materials from the game would not be evidence about the game. The
 * composition masses deliberately get none: a 200 m tower is not a rooftop platform
 * scaled fifty times, and `WorldPresenter` has a path for exactly this case.
 */
const blockoutVisuals: VisualInstance[] = route
  .map(alignedVisual)
  .filter((visual): visual is VisualInstance => visual !== null);

/**
 * Four lights, against a pool of two points and one spot. The pool assigns by
 * proximity, so these are spaced along the route rather than clustered: one in the
 * slot, one at the turn, one at the rise and one over the overlook.
 */
const blockoutLights: LightInstance[] = [
  { id: 'vista-light-slot', kind: 'point', transform: { position: [0, 4, -4], rotation: [0, 0, 0], scale: [1, 1, 1] }, color: '#45edff', intensity: 20, range: 14, castShadow: false },
  { id: 'vista-light-turn', kind: 'spot', transform: { position: [-6, 9, -24], rotation: [-1.1, 0.6, 0], scale: [1, 1, 1] }, color: '#ff4477', intensity: 30, range: 24, coneAngle: 0.7, penumbra: 0.72, castShadow: false },
  { id: 'vista-light-rise', kind: 'point', transform: { position: [-72, 6, -24], rotation: [0, 0, 0], scale: [1, 1, 1] }, color: '#50f5ff', intensity: 22, range: 18, castShadow: false },
  { id: 'vista-light-overlook', kind: 'point', transform: { position: [-116, 10, -24], rotation: [0, 0, 0], scale: [1, 1, 1] }, color: '#ffad52', intensity: 18, range: 20, castShadow: false },
];

/**
 * The angles this level was composed for.
 *
 * The review that prompted this level asked for hero vistas defined as a cone -- an
 * origin, an expected heading, an expected pitch and a subject -- rather than as a spot
 * on a plan. That is the only honest way to author a composition in first person: the
 * camera cannot be guaranteed, but route geometry makes a heading overwhelmingly
 * likely, and what has to be beautiful is the *probable* angle rather than every angle.
 *
 * They are exported for two reasons. `tests/vistaBlockout.test.ts` asserts the
 * composition against them, so "the tower left the frame" is a test failure rather than
 * something noticed a week later. And `?scene=vista&vista=<id>` spawns the player
 * standing in one, which is what makes a composition iterable at all -- otherwise every
 * look at the reveal costs a fifteen-second run to get back to it.
 *
 * `yaw` follows the simulation: 0 is down -Z, and forward is `(-sin, -cos)`.
 */
export interface VistaCone {
  id: string;
  origin: Vec3;
  yaw: number;
  /**
   * Where the shot expects the view to be, in radians, positive up.
   *
   * This is the number the first pass left out, and leaving it out hid the largest
   * problem in the frame. `settings.fov` is 92, which three reads as the *vertical*
   * angle, so the view spans 46 degrees up and 46 down from wherever it points. At an
   * eye height of a metre and a half and a pitch of zero, everything below the horizon
   * is floor -- half the frame, every frame. The reference has almost no ground plane in
   * it at all, because it is an upward composition.
   *
   * So a cone is an origin *and* a pitch, and the pitch is part of the composition
   * rather than something the player is left to find. What the level then owes the
   * player is a reason to be looking there.
   */
  pitch: number;
  /** What the shot is of, and why this angle exists. */
  subject: string;
}

/** Heading -X, which is the direction the street runs after the turn. */
const DOWN_STREET = Math.PI / 2;

const UP = Math.PI / 180;

export const vistaCones: readonly VistaCone[] = [
  { id: 'slot', origin: [0, 1.1, 2], yaw: 0, pitch: 14 * UP, subject: 'Compression. Seven metres wide, twenty-six tall, almost no sky.' },
  { id: 'reveal', origin: [0, 1.1, -26], yaw: DOWN_STREET, pitch: 22 * UP, subject: 'The turn. Cliff down the left, tower right of centre with sky both sides, bridge across the top.' },
  { id: 'street', origin: [-40, 1.1, -24], yaw: DOWN_STREET, pitch: 30 * UP, subject: 'Mid-street. Cliff, magenta wedge, tower and the bridge diagonal all in one frame.' },
  // At the foot of the tower, looking up it. Forty-two degrees puts the horizon at 94%
  // of the way down the frame, so the ground plane is a sliver at the bottom edge and
  // the rest is facade and sky -- the only shot on this route framed the way the
  // reference is framed.
  { id: 'overlook', origin: [-116, 7.1, -22], yaw: 0, pitch: 42 * UP, subject: 'The payoff. At the tower base, looking up 480 m of it, with the ground almost out of frame.' },
];

export function vistaCone(id: string): VistaCone | undefined {
  return vistaCones.find((cone) => cone.id === id);
}

/**
 * The cones, as something the simulation can act on.
 *
 * A cone is a statement about where a composition is meant to be seen from. A hint is
 * the same statement in a form the look nudge can read, so the two cannot drift: move a
 * cone and the nudge follows it, and the projection in
 * `tests/compositionPreview.test.ts` is looking at exactly the angle the game will try
 * to put the player at.
 *
 * Radii are the length of the moment, not the size of the space. `slot` and `reveal` are
 * tight because they are single points on a run-through; `street` is loose because the
 * whole middle of the street is the same shot; `overlook` is tight again because it is a
 * standing still moment at the end.
 *
 * Note what the nudge can actually deliver: `lookNudge.maxPitchOffset` is 18 degrees, so
 * `street` at 30 and `overlook` at 42 are only partly reachable from a level view. That
 * is deliberate. The overlook's 42 is earned by geometry -- a dead end at the foot of a
 * 480 m tower, where up is the only thing to look at -- and if the street's 30 turns out
 * to need the nudge rather than the player, the honest fix is a taller foreground at the
 * near end of the street, not a bigger cap on how far the game may move someone's aim.
 */
const HINT_RADIUS: Record<string, number> = { slot: 9, reveal: 11, street: 26, overlook: 9 };

export const vistaBlockoutHints: VistaHint[] = vistaCones.map((cone) => ({
  id: `hint-${cone.id}`,
  at: cone.origin,
  radius: HINT_RADIUS[cone.id] ?? 10,
  yaw: cone.yaw,
  pitch: cone.pitch,
}));

export const vistaBlockout: LevelDocumentV2 = {
  schemaVersion: 2,
  id: 'vista-blockout',
  name: 'Vista Blockout',
  units: 'meters',
  collision: blockoutCollision,
  visuals: blockoutVisuals,
  lights: blockoutLights,
  environmentPresetId: DEFAULT_ENVIRONMENT_PRESET_ID,
  assetCatalogVersion: DEFAULT_ASSET_CATALOG_VERSION,
  primitives: blockoutCollision,
  spawns: [{ id: 'vista-player', kind: 'player', position: [0, 1.1, 2], rotationY: 0 }],
  // No hostiles and no gating. This level is evidence about the image, and an
  // encounter would only put a health bar in front of it.
  encounters: [],
  offMeshLinks: [],
  vistaHints: vistaBlockoutHints,
  exit: [-129.5, 7.5, -24],
};
