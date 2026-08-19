/**
 * The Cyber-Dusk palette, shared by the interface and the 3D layer.
 *
 * The menu and boot screens are built from flat blocks of pure yellow, cyan and hot
 * pink over a near-black void, and that is the game's identity. The 3D layer had
 * drifted away from it: forty-odd hand-written hexes, all *near* these values and none
 * on them, with a lot of soft ambers and salmons that read as washed rather than
 * graphic -- and no yellow at all, which is the one colour the menu leads with.
 *
 * Keep these in step with the `--cyber-*` custom properties in `styles.css`.
 */
export const palette = {
  /** Near-black ground the whole look sits on. */
  void: '#070b10',
  ink: '#101419',
  panel: '#0d141a',
  /** Off-white. Used sparingly: large light surfaces are what flattened the contrast. */
  paper: '#dbe7e4',
  yellow: '#f4ec18',
  yellowHot: '#fff83d',
  cyan: '#08f7ff',
  red: '#ff2d55',
  dim: '#708188',
} as const;

/** Accent a traversal surface announces itself with. */
export const surfaceAccent = {
  'wall-run': palette.cyan,
  vault: palette.red,
  mantle: palette.red,
  'no-traverse': palette.yellow,
  default: palette.yellow,
} as const;

/** Hostiles read cyan or red; the player's own signals own the yellow. */
export const hostileAccent = {
  ranged: palette.cyan,
  aggressive: palette.red,
} as const;
