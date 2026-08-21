# Flowstate FPS

A browser-native single-player movement FPS prototype built with Three.js, Rapier, React, and TypeScript. The included **White Line** level alternates parkour routes and compact combat arenas; the same level format is editable in the bundled gameplay editor.

## Run it

Node 24 is required. A local copy is already available in `.tooling/` in this workspace; on a normal machine, install Node 24 LTS and run:

```sh
export PATH="$PWD/.tooling/node-v24.18.1-darwin-arm64/bin:$PATH" # this workspace only
npm install
npm run dev
```

Production and verification commands:

```sh
npm run build
npm test
npm run test:e2e
# Socket-free production-dist routing for restricted CI/sandboxes:
FLOWSTATE_STATIC_DIST=1 npm run test:e2e
```

## Controls

- `WASD`: move (momentum-free on the ground: velocity snaps to the input and stops the moment you release)
- `Shift`: sprint
- `Space`: jump / wall jump / contextual vault
- `Space` twice: directional dash or air-step, so spamming the key alternates jump, dash, jump
- `F` (hold): cast the hook at any static surface at least 3.5 m away and travel straight to it. You move along exactly the line you aimed at — gravity and movement input stand down for the duration — so the path is always the one you saw. Anything closer than the minimum is refused, since there is nothing to pull against. Arriving releases the hook and hands your speed back to air movement; letting go of `F` detaches early and keeps your momentum.
- `Q` (while hooked): pull yourself in faster. Each press adds to your travel speed for the rest of the hook, up to a ceiling, so you choose how hard to commit to a line. It has its own key so it can never be confused with a jump or a dash. Jumping is suppressed while hooked since it cannot fight the line, but double-tapping `Space` still dashes, which cancels the hook as a deliberate escape.
- `Space` (airborne, against a wall-run surface): wall jump — this always wins over the dash double-tap, so kicking down a corridor never turns into a dash
- `C` or `Ctrl`: slide
- `1` / `2`: draw the first or second carried weapon; `Tab` swaps between them
- Left mouse: fire
- Right mouse: ADS. Holding it locks onto the bot nearest the crosshair and tracks its centre mass. The acquisition cone covers roughly the visible screen; the lock drops when the target dies, leaves the wider hold cone, or moves behind cover, and manual look still applies first so you can drag off or switch targets.
- `E`: quick melee
- `R`: reload
- `Esc`: release Pointer Lock (or embedded-preview mouse capture) and pause

On a phone or tablet the game draws an on-screen scheme instead, chosen from
`(pointer: coarse)` — the device's *primary* pointer, so a laptop with a touchscreen keeps
its keyboard. A floating thumbstick moves (push it to the edge to sprint), a drag anywhere
looks, and a cluster under the right thumb carries `CUT`, `JUMP`, `HEAVY`, `GUN`, `HOOK`
and `SLIDE`, with `PULL` appearing only while a hook is out and `RELOAD`/`AIM` only while
the gun is up. `JUMP` twice is still the dash and the perfect dodge. `PAUSE` hands the run
back, since there is no `Esc` to press. The route is played in landscape and says so in
portrait; fullscreen and an orientation lock are requested where the browser supports them.

Editor gizmos use `W` for translate, `E` for rotate, and `R` for scale. Projects save directly to a folder in supporting browsers or export as `.fpsproj` archives elsewhere.

The pause overlay exposes live sensitivity, FOV, head-bob, wall-run roll, screen-shake, render-scale, graphics-quality, dynamic-resolution, and reduced-motion controls. Reduced motion is seeded from `prefers-reduced-motion` on first run and disables decorative interface wipes, parallax, speed lines, head bob, camera roll, and shake. Preferences persist locally. If an embedded browser rejects Pointer Lock, the game falls back to focused keyboard and bounded mouse input instead of failing.

## Guns

Weapons are assembled in the gun builder, reachable from the main menu and from the pause overlay. A build starts from one of four chassis — carbine, SMG, shotgun, DMR — which sets its base handling, then takes optic, barrel, magazine, grip and stock parts. Every part is a bounded multiplier on the chassis stats, resolved by `resolveWeaponStats` in `src/content/weapons.ts` and clamped so no combination escapes a playable envelope. Builds are saved to a local armory and any two of them are carried into a run with independent magazines and reserves.

Fitted parts are visible on the SMG, shotgun and DMR, which are built procedurally from parts. The carbine renders the authored `runner-rifle` model instead, because it looks considerably better than the procedural body; its part changes therefore affect stats only.

## Architecture

- `src/contracts.ts` contains presentation-safe simulation, content, save, and event contracts.
- `src/simulation/` owns the fixed-step world, kinematic movement motor, combat, bots, checkpoints, and objectives. Without a baked navmesh the bots fall back to direct steering with a ledge guard, so they hold their platform instead of chasing the player into the void. Kills and damage taken by surviving bots persist across checkpoint restores.
- `src/render/`, `src/audio/`, and `src/input/` are adapters; none owns gameplay state.
- `src/audio/AudioManager.ts` synthesises the whole mix in one `AudioContext` with no
  samples: every cue is scheduled off the tick it happened on plus its own flight time, and
  a shared HDR window with one importance per cue decides what is worth a voice.
  `tests/support/offlineAudio.ts` renders that graph offline and `tests/support/loudness.ts`
  measures it to BS.1770-4, so true peak and loudness are numbers rather than opinions.
- `src/input/touchControls.ts` owns the touch scheme as data and arithmetic — which device
  wants it, what a thumb at an offset is asking for, and which controls exist — and
  `src/game/TouchControls.tsx` only renders it.
- `src/render/presentation/` owns the look, and it is built as an illustration rather than
  as a photograph. `toneCurve.ts` is the one curve between the lit scene and the screen —
  no tone mapping runs anywhere else — and it has no toe, so a surface may reach black.
  `toonBands.ts` decides how many steps each material shades in and what hue it turns as it
  leaves the light; `facePaint.ts` decides a generated mass's faces by which way they point;
  `graphicShapes.ts` is the vocabulary combat is drawn with; `cameraDirection.ts` treats
  field of view as an animation system; and `animationStepping.ts` steps hostile poses on
  twos while leaving the camera, the aim and the mix continuous. All of them are pure and
  unit tested, because `GameRenderer` needs WebGL to construct and cannot be reached from a
  test. `RENDER.md` is the brief they were built from.
- `src/render/assets/` owns the hash-verified GLB/KTX2 catalogs, abortable shared cache, fallbacks, and resident-memory estimates.
- `src/content/weapons.ts` owns the weapon chassis and part catalog plus the pure stat resolution used by both the simulation and the builder UI.
- `src/ui/WeaponBuilder.tsx` is the armory and loadout screen, shared by the main menu and the pause overlay.
- `src/ui/Primitives.tsx` owns the shared interface vocabulary — panels, buttons, meters, collapsible sections, tabs, tooltips, dialogs, and icon buttons — used by both the game and the editor.
- `src/game/` splits runtime wiring (`GameScreen`) from presentation (`GameOverlay`, `Hud`) so the interface can be tested without WebGL or Rapier.
- `src/editor/` owns versioned geometry, encounter/checkpoint, bot-assignment, and off-mesh-link editing plus validation, undo/redo, archive persistence, and worker-based Recast navmesh baking. Its palette, hierarchy, and inspector are collapsible, the hierarchy is filterable by type, and a live status bar reports counts, camera mode, navmesh freshness, validation state, and the current selection. Below 900 px the inspector becomes a toggleable drawer.
- `src/runtime/` connects input to the 60 Hz simulation and renders snapshots on `requestAnimationFrame`.

The game and editor are lazy-loaded separately. Static geometry uses authored collision primitives, the player uses Rapier's kinematic character controller, and all camera/viewmodel effects remain cosmetic.

White Line uses invisible gameplay collision plus catalogued visual instances. Normal play renders the VX-09, corporate hunters, and modular cyber-dusk environment; primitive art is retained only as a recoverable diagnostic fallback.
