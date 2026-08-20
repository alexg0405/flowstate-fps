# Handoff: pivot to first-person character action

Paste the block below into a fresh Claude Code session in this repo. It is
self-contained. `AUDIT.md` has the full history of prior work — sections 5–14,
worth skimming, especially the traps in sections 11, 12 and 14.

Repo state: `alexg0405/flowstate-fps`, public, `main` at `562e7fc`, clean tree.

---

```
You are picking up Flowstate FPS, a browser first-person game (Three.js + Rapier +
React + TypeScript) built as a movement shooter along a linear 172-metre route. Read
AUDIT.md first — it records nine phases of prior work, what was measured, and several
mistakes worth not repeating.

The job: pivot it into a **first-person character-action game**. Melee becomes the
core verb, the existing chain becomes a style meter, and the linear route becomes
locked rooms you fight your way out of. Think Ghostrunner and Ultrakill, not Devil
May Cry — the camera stays where it is, for a reason spelled out under "Decisions
already taken" below.

This is a pivot, not a rewrite. A surprising amount of the game is already the game
you want; the section on what transfers is the most important part of this brief.

## Setup and the bar you must hold

    export PATH="$PWD/.tooling/node-v24.18.1-darwin-arm64/bin:$PATH"

All of these must stay green:
- `npm test` — 328 passing / 31 files
- `npm run typecheck` — clean. Run it every time: vitest transpiles WITHOUT
  typechecking, so tests can pass while types are broken.
- `npm run build` — clean
- `FLOWSTATE_STATIC_DIST=1 npm run test:e2e` — 41 passing (Chromium + Firefox)
- `FLOWSTATE_STATIC_DIST=1 npx playwright test --project=chromium tests/e2e/visual.spec.ts`
- `npm run art:validate` — clean, 1.93 MiB of a 25.00 MiB budget

Verify in a real browser at 1280x720 as well as through DOM assertions. Every screen
is reachable without playing: `/` is the menu, `/?mode=editor` the level editor,
`/?mode=game` the run — its pause card is the standby overlay — and
`/?mode=game&scene=finish` drops you onto the results screen. Only `editor` and
`game` are read from the URL (`src/App.tsx`), so the gun bench is reached by clicking
`Gun builder` on the menu or in the pause overlay.

The e2e suite has a pointer-lock-rejected fallback path (see `app.spec.ts`) that lets
a headless browser drive the live HUD. Use it; it is how combat gets tested.

## Decisions already taken — do not relitigate these

**The camera stays first person.** Third person is the instinct for this genre and it
is the wrong call here. There is no player-body art at all — the player is a camera
holding a rifle — so third person means authoring a character with a full melee
animation set through `tools/art/generate_vertical_slice.py` and `npm run art:build`,
plus a new orbit camera with hard lock-on, plus discarding `ViewmodelPresenter` and
the first-person camera work in `GameRenderer`. That is months, and it throws away the
part of the codebase that already works. Ghostrunner is first-person katana with
dash, wall run, grapple and room-locked arenas: that is this movement kit with the
gun swapped for a blade.

**The arena gating stays.** `updateObjectives` in `FlowSimulation` locks the exit
until every encounter is cleared. That was a flaw for a speedrun game and it is the
room-lock the entire character-action genre is built on.

**Guns stay, as a secondary.** Ultrakill and DMC both give you a sidearm to extend
combos. Do not delete the weapon system; demote it.

**The movement kit is the differentiator.** Dash-chain with per-surface recharge, a
commit-cost grapple, wall runs, wall jumps, vaults, slides. Do not rebuild it, and do
not let combat tuning quietly strangle it.

## What already transfers — read this before designing anything

This is the part that makes the pivot cheap. All of it is verified in source, not
assumed.

- **The style meter already exists and is already correct.** `ComboLinkKind` in
  `src/contracts.ts` is `dash | wall-run | wall-jump | vault | hook | pull | kill`,
  and `addComboLink` in `FlowSimulation` refuses a repeat of the same kind inside one
  chain (`if (player.comboKinds.includes(kind)) return;`). That is Devil May Cry's
  anti-mashing rule, in the simulation, with tests on it in
  `tests/comboChain.test.ts`. The window is `comboScoring.linkWindowSeconds` = 2.5 s.
- **Kills already feed the chain.** `addComboLink(events, 'kill', headshot ? 2 : 1)`,
  and `'kill'` is deliberately exempt from the no-repeat rule. Combat already extends
  the chain rather than interrupting it — you do not need to build that.
- **Rank is already a style rank.** `runScoring.ranks` gates S behind
  `minPeakCombo: 8` and `maxDeaths: 0`.
- **Soft lock-on exists.** `player.lockedTargetId`, and the `aimAssist` profile in
  `content/config.ts` with `acquireCosine`, `holdCosine`, `slowdownScale` and
  `maxTurnRate`. It is tuned for gunplay; it is the right primitive for melee snap.
- **Telegraphs exist.** The `enemyTelegraph` event carries a windup duration, and
  AUDIT.md §5 calls it the most important cue in the mix. That is a parry window,
  already authored and already audible.
- **Melee plumbing exists.** `Action.Melee` (`1 << 11`, bound to `KeyE` in
  `InputController`), a 0.35 s `meleeTimer`, `closestBotInArc(origin, direction,
  weapon.meleeRange)`, `meleeDamage: 70` and `meleeRange: 2.25` on every weapon
  definition, a `melee` event, an audio case and hit feedback. It is a stub, but
  nothing has to be invented.
- **Enemy design has a proven pattern.** The bulwark — a 137-degree frontal arc that
  scales incoming damage to 0.18, brought round at 1.5 rad/s, with a 57-degree firing
  cone so flanking removes its damage as well as its armour — is already a
  break-the-guard enemy. AUDIT.md §12 records how it was built and sized.
- **The interface is already in the right idiom.** AUDIT.md §13 put the menus,
  overlays, results and feedback into a Persona-style register — sheared blocks, cut
  edges, stamped confirmations, a comic-burst kill marker and an all-out chain
  flourish. DMC and Persona share that visual family. None of it needs redoing.

## The tension you have to hold

- **The simulation is deterministic and must stay that way.**
  `tests/simulationReplay.test.ts` proves identical trajectories from identical input
  tapes. Hitstop is the first thing this genre wants and the obvious implementation —
  freezing the fixed step — breaks that. Do it in the presentation layer only.
- **Do not undo the HUD reduction.** AUDIT.md §12 took the play frame from thirteen
  modules to six in four zones because it was illegible in motion, and §13 added a
  kill burst and a chain flourish under a hard rule: nothing new inside fifteen
  degrees of the crosshair, which is 93 px at 720p and a 92-degree vertical FOV. A
  style meter is a standing temptation to put a big loud readout on the play frame.
  The chain multiplier is already in the reticle cluster. `tests/ui.test.tsx` has
  cases asserting the reticle zone holds only the flow-critical set and that the cut
  modules stayed cut. **Update them, do not delete them.**
- **Combat spacing will fight the level.** The movement kit is tuned for traversal —
  35 m grapple range, 21 m/s dash — across a 172 m corridor with three arenas that
  are waypoints on a route rather than rooms. Retuning for close-quarters combat will
  expose that. The editor exists and bakes navmesh; use it rather than fighting the
  shipped level.

## Architecture rules

- `src/contracts.ts` is the presentation-safe boundary. Extend it; don't bypass it.
- `src/simulation/` owns ALL gameplay state at a deterministic 60 Hz.
  `src/render/`, `src/audio/`, `src/input/` are adapters that own none. Combat
  changes DO belong in the simulation — this is the first pass in a while that
  legitimately touches it. Feedback, hitstop and juice do not.
- Tuning lives in `src/content/config.ts` and `src/content/modifiers.ts`. Don't
  inline constants at call sites.
- **Every decorative effect honours `reducedMotion`.** The pattern is in the
  stylesheet: guard with `@media (prefers-reduced-motion: no-preference)` and add a
  `.reduced-motion <selector> { animation: none !important; }` escape, because the
  setting is a save-file toggle and not only a media query. Hitstop and screen shake
  need the same treatment — `settings.shake` already exists.
- `src/render/palette.ts` is the single source of truth for 3D colour, kept in step
  with the `--cyber-*` properties in `styles.css`. Change one, change both.

## Items, roughly in order of payoff

### 1 — Make the slash the primary verb
Move melee to `Action.Fire` (LMB) and retune the existing arc: shorter than the 0.35 s
cooldown, wider than the current cone, and damage that kills a ranged bot in one or
two hits rather than chipping it. Everything you need is in `updateCombat` and
`closestBotInArc`. Keep `Action.Melee` free for a heavy or a launcher.

This is the cheapest possible test of whether the pivot is fun, and it needs no art:
you will be swinging an invisible blade with the rifle still on screen. Ugly, and it
tells you in an hour.

### 2 — Hitstop
The single biggest juice item in the genre and there is none. Freeze 3–6 frames on a
landed hit, scaled by damage. **Presentation layer only** — see the tension section.
`GameRenderer.render` already computes `frameSeconds` and pins it to zero under
`visualRegression`, which is the seam to work with.

### 3 — A defensive verb
Give the dash invulnerability frames, and a perfect-dodge window keyed off the
existing `enemyTelegraph` windup: dodging inside it should pay a chain link and
something loud. This converts a warning that already exists into a mechanic, and it
is the layer that stops combat being a damage race.

### 4 — Melee variety into the chain
Extend `ComboLinkKind` so different melee actions are different link kinds — the
no-repeat rule then does the work for free, and mashing one attack stops paying. This
is a `contracts.ts` change plus `addComboLink` call sites, and `tests/comboChain.test.ts`
is where it gets proved.

### 5 — Crowds
Nine hostiles across three arenas is three per room; this genre wants six to twelve
at once and waves within a room. `botProfiles` is a config map and spawns are level
data, so this is mostly content. Watch the frame budget — AUDIT.md §10 and §14 have
the draw-call and triangle numbers and how they were measured.

### 6 — A launcher and air combat
Pop an enemy up and follow with the movement kit. This codebase is unusually ready:
air control, dash and a grapple that already publishes whether a cast would be
accepted all exist. Grapple-to-enemy is Nero's Snatch and the raycast is already
there.

### 7 — The blade
`runner-rifle.glb` is authored in `tools/art/generate_vertical_slice.py`. This is the
one item that requires `npm run art:build`, which regenerates every GLB — read trap 9
before touching it. A blade is far simpler geometry than a rifle.

### 8 — Repoint the bench
The gun bench is four chassis and five part slots with a 3D preview. If melee is the
core verb that is the wrong reward layer, but the build/parts/loadout UI maps well
onto blade styles with different chain behaviours. A repoint, not a rewrite, and it is
last because it is worthless until the combat loop is proven.

## Traps that already cost real time — read before measuring anything

1. **`npm run typecheck` is not optional.** Vitest transpiles without typechecking.
   Tests pass while types are broken.
2. **Screenshots taken ~2 s after entering a run race the async asset load** and come
   back washed pale. Wait 6 s+. The same scene measured rgb(197,214,210) at 2.2 s and
   rgb(31,39,45) at 6 s. `tests/e2e/visual.spec.ts` is immune because
   `openPresentation` waits on the asset responses — prefer that pattern.
3. **`maxDiffPixelRatio` in the visual spec is 0.035**, about 32k pixels. A total
   character-rendering failure once passed inside it. Don't treat a pass as proof;
   tighten it temporarily when you need a real number, then put it back. If a change
   moves the frame legitimately, regenerate the baselines and report the pixel count.
4. **Regenerating the visual baselines needs `--timeout=150000`.** At Playwright's
   default 30 s, two of the three time out during the update pass and then pass on a
   normal run, which looks like flakiness and is not.
5. **The visual baselines hide everything except the canvas**
   (`.game-shell > :not(.game-canvas) { display: none }`), so pure UI work cannot move
   them — but anything in `src/render/` or the simulation's visible state will.
6. **The whole e2e suite runs with reduced motion ON.** Headless Chromium reports
   `prefers-reduced-motion: reduce` and `saveDefaults()` seeds the save from that
   query, so no existing test sees any of the interface motion. Call
   `page.emulateMedia({ reducedMotion: 'no-preference' })` before `goto` when you need
   it, and do not read the suite's stability as evidence that animation is safe.
7. **`sharp`'s `stats()` reads the input image and ignores a pending `.extract()`.**
   Materialise the crop first: `await sharp(f).extract(box).png().toBuffer()`, then
   `stats()` on that.
8. **Playwright's actionability checks are sensitive to animation.** An element whose
   box is still moving is "not stable" and `click()` waits for it. Anything animating
   on mount near a button the suite presses needs to settle fast or be
   `pointer-events: none`.
9. **Don't touch `tools/art/generate_vertical_slice.py` casually.** If you do, you
   MUST run `npm run art:build`, which regenerates every GLB — the characters shipped
   visibly broken once for exactly this reason. Item 7 puts this on the table
   deliberately; everything before it should avoid the pipeline entirely.
10. **The in-app preview pane reports `visibilityState: 'hidden'` permanently**, which
    starves `requestAnimationFrame` and throttles timers to ~1 s. Anything driven off
    frames appears frozen there and is fine in a real browser. Measure through
    Playwright, and give frame-driven state a timer floor so a backgrounded tab cannot
    strand it.
11. **First-person melee has a depth-perception problem and it is the make-or-break
    risk of this whole pivot.** Judging swing range without a visible arm is genuinely
    hard, and it is why most first-person melee feels bad. Ghostrunner solves it with
    generous range plus assist — the assist already exists here. Budget real tuning
    time for reach, arc and target snap before adding enemies or art. If after honest
    tuning it still feels bad, say so and stop rather than building content on top of
    a verb that does not work.

---

Work one item at a time. After each, run the full bar above and tell me what you
measured rather than what you expect. Screenshot every screen you touch at 1280x720
and show me. If an item turns out to be a worse idea than it looked — and item 6 is
the candidate, because juggling in a game with this much air mobility may just be
chaos — say so and stop rather than shipping it.
```
