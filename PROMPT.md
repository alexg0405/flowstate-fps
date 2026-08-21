# Handoff: make the mix interactive, fix what the HUD claims, and pay the player for aggression

Paste the block below into a fresh Claude Code session in this repo. It is
self-contained. `AUDIT.md` has the full history of prior work — **section 15 is the one
that matters**, because it records the pivot the game has just been through and the
sections before it describe a game that no longer exists.

Repo state: `alexg0405/flowstate-fps`, public, `main` at `f35050b`, clean tree.

---

```
You are picking up Flowstate FPS, a browser first-person character-action game (Three.js
+ Rapier + React + TypeScript). Read AUDIT.md section 15 first, then skim sections 11–14
for the presentation and world work the pivot built on. Section 15 also records one item
that was built, measured and thrown away, and why — that is the standard for this repo.

The game today: a blade on the left mouse button is the primary verb, a heavy on `E`
sweeps a crowd and breaks a guard, a dash arms invulnerability frames that turn an enemy
telegraph into a perfect dodge, a flow chain with ten distinct link kinds is the style
meter, and twenty-eight hostiles across seven waves fill three rooms you fight your way
out of. Guns are a secondary on the right mouse button with a parts bench behind them.

Four jobs, and the first is the largest.

## Setup and the bar you must hold

    export PATH="$PWD/.tooling/node-v24.18.1-darwin-arm64/bin:$PATH"

- `npm test` — 427 passing / 37 files
- `npm run typecheck` — clean. Run it every time: vitest transpiles WITHOUT
  typechecking, so tests can pass while types are broken.
- `npm run build` — clean, and it must come BEFORE any e2e run (see the traps)
- `FLOWSTATE_STATIC_DIST=1 npm run test:e2e` — 54 cases, and **this is not currently
  green**. Read the e2e trap below before you conclude anything from it.
- `FLOWSTATE_STATIC_DIST=1 npx playwright test --project=chromium tests/e2e/visual.spec.ts`
- `npm run art:validate` — clean, 1.93 MiB of a 25.00 MiB budget

Every screen is reachable without playing: `/` is the menu, `/?mode=editor` the level
editor, `/?mode=game` the run — its pause card is the standby overlay —
`/?mode=game&scene=finish` the results screen, `/?mode=game&scene=hunters` a staged pair,
and `/?mode=game&scene=crowd` the biggest authored wave with no gating, which is how you
measure the worst frame in one step. Only `editor` and `game` are read from the URL
(`src/App.tsx`); the bench is reached by clicking `Gun builder`.

The e2e suite has a pointer-lock-rejected fallback (`tests/e2e/app.spec.ts`) that lets a
headless browser drive the live HUD. It is how combat gets tested. Look at
`fightIntoTheAtrium` before writing a new one — driving this game blind is harder than it
looks and that helper encodes several lessons.

## Decisions already taken — do not relitigate these

**First person stays.** There is no player-body art and the whole viewmodel layer assumes
a camera holding a weapon.

**The blade's reach is load bearing.** 3.6 m through a 130-degree cone. Judging reach in
first person with no visible arm is the risk the pivot turned on, and the generous envelope
is the answer to it. A launcher was rejected specifically because that reach makes vertical
displacement meaningless — AUDIT §15 has the numbers. Do not shorten it to make room for
something else.

**The blade is generated TypeScript, not a GLB.** `ViewmodelPresenter.buildBlade`. Read
trap 4 before you think about the art pipeline.

**Guns stay, with their parts bench.** The player asked for this explicitly. Whatever you
do to the HUD or the loadout, `Gun builder` keeps working: four chassis, five slots, the
3D preview, the stat rows.

**Hitstop and the duck are presentation only.** The simulation steps at a deterministic
60 Hz and `tests/simulationReplay.test.ts` proves identical trajectories from identical
input tapes. Do not gate the fixed step on anything the renderer decides.

## Job 1 — make the mix interactive

This is the big one and it is a design job, not a plumbing job. The player's words:
*"I like the dull effects of the sound currently but I want to combine it with other
sounds to make something great."*

Read `src/audio/AudioManager.ts` end to end first. The register is right and is not up for
debate: three layers per cue — a driven `sub` carrying the weight, a lowpassed `boom`
carrying the body, and at most eight milliseconds of `tick` for definition — plus a `bed`
of a held floor and a speed-driven movement layer, a `duck` that pulls the whole bus down
on the few events that deserve it, a generated convolution reverb with three send levels,
and a limiter. Keep all of that. AUDIT §15 records what the arcade version sounded like and
why; do not walk it back.

What is missing is that the mix does not **react** to how the run is going, and its cues do
not **combine** — they queue. Four things, roughly in order of how much they buy:

1. **Give the mix a key.** Every pitch in the file is currently an arbitrary number, which
   is why two cues landing together sound like two cues landing together. Pick a root and
   derive every tonal layer as an interval over it. A kill sting and a chain tone in the
   same key harmonise; at 880 and 1320 Hz they collided. This is the single change most
   likely to turn a pile of sounds into something that sounds composed, and it is mostly a
   table of ratios plus a helper.
2. **Make the chain drive the mix.** The chain is the style meter and the mix says almost
   nothing about it — one climbing tone per link. It should be audible that a chain is
   *live*: the bed tightening, a harmonic opening, the reverb send rising, the floor moving
   up a scale degree per few links. `snapshot.player.combo` has links, multiplier and the
   window fraction; `sustain` already runs every frame and is the natural home. Take care:
   `comboScoring.flourishFromLink` exists because a full-frame effect that fires constantly
   is decoration, and the same is true of a sound.
3. **Let a cue depend on what it hit.** A slash into a hunter, into a bulwark's plate, and
   into air are three different events already (`deflected`, `targetEntityId`, and the
   `melee` event's `heavy` flag) and the mix distinguishes some of it. Material and outcome
   should shape the layers, not just their level — a killing blow should *combine* the cut
   and the kill rather than playing both.
4. **Give the three blade styles audible identity.** `content/blades.ts` has Tempo, Cleave
   and Riposte with different recoveries and different chain rules, and they sound
   identical. The style is carried in the save and reaches the runtime already.

Test it the way the existing audio tests do: `tests/interfaceAudio.test.ts` drives the real
`AudioManager` against a recording double that implements exactly the Web Audio surface the
class uses, and it now records voices, noises, ducks, reverb sends, bed automation and
filter sweeps. That harness is the reason this file can be changed with any confidence at
all — extend it rather than working around it.

**You cannot hear any of this.** Say so. Guard what you can (register, layer counts,
relative levels, that a cue reacts to the state it claims to react to), verify the graph
runs in a real browser with the e2e that drives it through combat, and tell the player
which constants to turn.

## Job 2 — the HUD says CARBINE while a blade is on screen

A real bug, spotted by the player. `src/game/Hud.tsx` renders the ammo corner as
`activeWeapon?.name` plus a magazine count, unconditionally — so it reads `CARBINE 30/120`
while the blade is what is in the player's hands and what is drawn on screen.

The fix is not just a label. `ViewmodelPresenter` decides which weapon is visible from a
0.95 s `gunHold` timer it owns privately, so the HUD has no way to agree with it — and two
timers in two layers is how you get a corner that says `CARBINE` over a blade. Move the
decision into the simulation, publish it on the snapshot (something like
`player.weapons.inHand`), and have both the viewmodel and the HUD read the same field.

Then the corner should say what is actually in hand: the blade's style with no ammo when
the blade is up, the gun with its magazine when the gun is up. Note that the ammo readout
has an `aria-label` announcing the magazine capacity and `tests/ui.test.tsx` asserts it —
that accessibility work survived two HUD passes, so keep it working for the gun case rather
than deleting it.

Two constraints. The reticle-cluster rule from AUDIT §12 still holds: nothing new inside
fifteen degrees of the crosshair, which is 93 px at 720p. And the play frame is six
readouts in four zones — this is a change to what an existing corner says, not licence for
a seventh.

## Job 3 — keep the gun builder working

Not a change; a constraint the player stated. `src/ui/WeaponBuilder.tsx` and
`src/ui/WeaponPreview.tsx`. The bench already has a blade section that picks a style and a
gun section that assembles a build, and the preview drives the game's own
`ViewmodelPresenter` so fitting a drum magazine shows the drum. Four e2e cases cover it.
Whatever job 2 does to the loadout or the snapshot, those keep passing.

## Job 4 — life from damage

New mechanic, and the design is yours to make but here is the shape the rest of the game
argues for.

Healing on a **kill**, scaled by the **chain multiplier**, capped per kill, and **no
out-of-combat regeneration at all.** The reasoning: the health pool was retuned for crowds
and the answer to being hurt should be to fight better, not to disengage. A regen that
rewards hiding fights everything the pivot built — and the chain is already the game's
measure of playing well, so tying the health economy to it makes the style meter matter
in a second dimension.

Where it goes:
- The kill path in `FlowSimulation.damageBot`, which already awards score at the chain
  multiplier and adds the kill link. `PLAYER_MAX_HEALTH` is `playerHealth` in
  `content/config.ts`, at 140.
- A `heal` event on the contract, so the mix and the HUD can both react. The health corner
  already has bands (`critical`/`warning`/`nominal`) and a vignette keyed to them.
- `content/blades.ts` is the obvious place for variation — a style that heals more, or a
  fourth style built around it — but only if the numbers earn it.

Measure it, do not assert it. The crowd balance is documented in `content/config.ts`: five
brawlers on the player is about 92 damage a second, a heavy one-shots a brawler and sweeps
three, and the Roofline puts eight on the deck. Lifesteal changes whether that room is a
fight or a formality. `?scene=crowd` stages the worst case in one browser step, and the
headless simulation harnesses in `tests/` are much faster to iterate against than the
browser.

## Traps that have already cost real time

1. **`npm run typecheck` is not optional.** Vitest transpiles without typechecking.
2. **`npm run build` before any e2e run.** `FLOWSTATE_STATIC_DIST=1` serves `dist/`
   through Playwright's own route interception, so a stale build means you are testing the
   previous commit. This has produced at least one deeply confusing failure.
3. **The e2e suite is not currently green and it is probably not your fault.** Read the
   last subsection of AUDIT §15 before you spend an hour on it. Startup measures 7.7–8.9 s
   and measures the same before the crowd landed; every failing case passes in isolation;
   the failures move between runs and arrive with load averages of seven to sixteen. Check
   `uptime` before you believe a red suite, and run the targeted subset for what you
   touched rather than the whole thing on a loaded machine.
4. **Don't touch `tools/art/generate_vertical_slice.py`.** Running `npm run art:build`
   regenerates every GLB and the characters shipped visibly broken from exactly that.
   Section 14 and the blade both set the other precedent: generate geometry at runtime.
   Blender 4.5.10 is bundled if you genuinely need it.
5. **Screenshots taken ~2 s after entering a run race the async asset load** and come back
   washed pale. Wait 6 s+, or use the `openPresentation` pattern in `visual.spec.ts`, which
   waits on the asset responses.
6. **`maxDiffPixelRatio` in the visual spec is 0.035**, about 32k pixels. A total
   character-rendering failure once passed inside it. Tighten it to `0.00001` when you want
   a real number, then put it back — and regenerating needs `--timeout=150000` or two of
   the three time out during the update pass and then pass on a normal run.
7. **The visual baselines hide everything except the canvas**, so pure UI work cannot move
   them — but anything in `src/render/` or the simulation's visible state will. Job 2 is UI;
   job 1 is neither. If job 1 moves them, something is wrong.
8. **AUDIT trap 6 is stale.** Both browsers now report
   `prefers-reduced-motion: no-preference`. Emulate the media explicitly at both ends when
   a test cares.
9. **The in-app preview pane reports `visibilityState: 'hidden'` permanently**, which
   starves `requestAnimationFrame`. The run clock freezes and the player never moves. It is
   fine for static screens and useless for gameplay — measure through Playwright.
10. **Every decorative effect honours `reducedMotion`**, guarded with a
    `@media (prefers-reduced-motion: no-preference)` block *and* a
    `.reduced-motion <selector> { animation: none !important; }` escape, because the
    setting is a save-file toggle as well as a media query. Hitstop and the camera shake
    do the same in code. Note that sound is not motion — do not gate audio on it.
11. **There is no volume control anywhere in the game.** With a continuous bed under the
    mix that is now a real gap rather than a theoretical one, and job 1 makes it worse. It
    wants a save field, a bus gain multiplier and a row next to reduced motion in
    `SettingsPanel`. Consider doing it first; it is small, and it is the thing that lets a
    player live with an aggressive mix.

## Architecture rules

- `src/contracts.ts` is the presentation-safe boundary. Extend it; don't bypass it.
- `src/simulation/` owns ALL gameplay state at a deterministic 60 Hz. `src/render/`,
  `src/audio/`, `src/input/` are adapters that own none. Job 4 belongs in the simulation.
  Job 1 does not. Job 2 straddles it deliberately: the *decision* moves down so both
  presentation layers can agree on it.
- Tuning lives in `src/content/` — `config.ts` for the run, `blades.ts` for the blade,
  `weapons.ts` for the gun. Don't inline constants at call sites, and don't leave two
  sources of truth for the same number: the melee envelope moved out of `config.ts` into
  `blades.ts` for exactly that reason.
- `src/render/palette.ts` is the single source of truth for 3D colour, kept in step with
  the `--cyber-*` properties in `styles.css`. Change one, change both. Hostiles read cyan
  or red; the player's own signals own the yellow.
- Presentation decisions that are pure get extracted and unit tested —
  `ResolutionController`, `visualBatching`, `citySkyline`, `hitstop`. `GameRenderer` needs
  WebGL to construct, so anything left inside it cannot be reached from a test.

Work one job at a time. After each, run the full bar and tell me what you measured rather
than what you expect. Screenshot every screen you touch at 1280x720 and show me. If a job
turns out to be a worse idea than it looked, say so and stop rather than shipping it —
AUDIT §15 has a worked example of doing exactly that.
```
