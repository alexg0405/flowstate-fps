# Paste-ready prompt

> **Status: Phases 1, 2, 4 and most of 3, 5 and 6 are done** in this working tree —
> see sections 5–10 of `AUDIT.md` for what landed and how it was verified. Pick up
> the outstanding items below.
>
> **Still outstanding:**
> - Item 14's second half: enemy and encounter variety (section 7).
> - Item 18, the value hierarchy. My albedo diagnosis in the audit was **wrong** —
>   measured, the floor's albedo is unremarkable and its dominance comes from the
>   sun raking across it. This is a lighting balance task (section 9).
> - Item 23, the HUD reduction. Now *more* pressing: phases 2–4 added six more
>   readouts to a HUD the audit already called too dense (section 9).
> - Item 24's `BatchedMesh` work. Lights, dynamic resolution and shadow casters are
>   done and measured; the main pass is still 250 draw calls from 264 meshes.
>   Section 10 has the baseline numbers and what the refactor actually involves.
>
> Notes for whoever picks this up:
> - Save schema is **V4** with a whole `bestRun` record (including an optional
>   recorded `ghost` path and the `modifierId` it was set under) and a working
>   V1→V4 migration chain in `saveStore.ts`. Follow that pattern.
> - `content/config.ts` owns `movementProfile`, `comboScoring`, `runScoring` and
>   `ghostTrack`. Tuning belongs there, not inlined at call sites.
> - `content/modifiers.ts` owns the daily contracts. Bot profiles are bent
>   multiplicatively by `scaledProfile`, so authored profiles stay authoritative.
> - The chain's two anti-farm rules in `comboScoring` are load bearing and both
>   have tests. Read the comment before changing either.
> - `recoilHoldSeconds` suspends both recoil recovery and bloom shedding after each
>   shot. Remove it and neither accumulates at any rate that also settles between
>   bursts; both had exactly that bug before a test found it.
> - Aim assist is slowdown plus a rate-capped nudge, not convergence. Widening
>   `acquireCosine` or replacing `maxTurnRate` with a blend puts the aimbot back.
> - Art is generated: `npm run art:build` regenerates `.blend` sources from
>   `tools/art/generate_vertical_slice.py` and re-exports every GLB. If you change
>   that script, **rebuild** — the characters shipped broken for exactly this
>   reason. `validation.minimumRigAttachments` in the catalog now guards it.
> - The grade pass runs before `OutputPass` deliberately; the comment explains why
>   moving it is a trap. Speed cues live in that same pass to avoid a new one.

Copy the block below into a fresh Claude Code session in this repo. It is
self-contained: every claim in it was verified against source, and every file
path is real. `AUDIT.md` in the repo root has the full evidence if you want the
reasoning behind any line.

If you want to run it in stages instead of all at once, delete the sections you
aren't doing yet — the sections are ordered so each one stands alone.

---

```
You are working on Flowstate FPS, a browser movement-FPS in this repo (Three.js +
Rapier + React + TypeScript, ~9.3k LOC). Read AUDIT.md first — it is a verified
audit of this exact tree and it contains the evidence for everything below.

Baseline you must not regress: `npm test` = 262 passing, `npm run typecheck` =
clean, `npm run build` = clean, `npm run test:e2e` = 35 passing, the 3 Chromium
visual baselines in `tests/e2e/visual.spec.ts-snapshots/`, and
`npm run art:validate` = clean. Node 24 via
`export PATH="$PWD/.tooling/node-v24.18.1-darwin-arm64/bin:$PATH"`.

Respect the existing architecture. It is good and I do not want it rewritten:
- `src/contracts.ts` is the presentation-safe boundary. Extend it; don't bypass it.
- `src/simulation/` owns ALL gameplay state. `src/render/`, `src/audio/` and
  `src/input/` are adapters that own none.
- The simulation is bit-deterministic and `tests/simulationReplay.test.ts` proves
  it. Every gameplay change must keep it deterministic — use the existing
  `SeededRandom`, never `Math.random()`, in the simulation.
- Every decorative effect must honour the existing `reducedMotion` setting.
- Add tests alongside each change, matching the style in `tests/`.

Work in the phase order below. After each phase, run the tests and typecheck, and
tell me what changed and what it feels like. Do not move to the next phase until
the current one is green.

=== PHASE 1 — Make combat feel fair ===
These are confirmed bugs. Fix them before anything else; the game currently
punishes the player with feedback they cannot see or hear.

1. Hit confirmation is invisible. `GameRuntime.loop` empties `pendingHits` on
   every 20 Hz UI push, so `Hud`'s damage numbers and hitmarker unmount after
   ~50 ms while the CSS asks for 0.75 s and 0.22 s. Give the HUD ownership of hit
   lifetimes so each hit animates fully regardless of the UI throttle.

2. Taking damage plays the hit-CONFIRM sound. `updateBots` pushes a `hit` event
   with `targetEntityId = player.id`, and `AudioManager.consume` matches
   `kind === 'hit'` without checking the target. Split damage-dealt from
   damage-taken. While you're in there: `enemyAttack`, `death`, `melee`,
   `reloadStart`, `reloadComplete`, `gateOpen` and `impact` currently have no
   audio at all. Give them sound. Add a distinct dry-fire click.

3. Taking damage spawns a red impact ring inside the camera.
   `FxPresenter.consume` treats the player's `hit` event (whose position is
   `cameraPosition()`) as a world impact. Route player damage to a directional
   damage indicator instead — I need to know where I'm being shot from.

4. Enemy fire is invisible, inaudible and instant. `updateBots` deals full damage
   the tick `fireCooldown` expires with line of sight — no windup, no tracer, no
   aim error. Two aggressive bots are ~47 DPS against 100 HP. Add a telegraphed
   windup, a visible tracer, and audible fire. Keep it deterministic.

5. Dry-firing locks the player in the firing state. In `updateCombat`, the
   `if (slot.ammo <= 0) { ...; return; }` branch skips the
   `action = 'neutral'` reset, so with 0 ammo and 0 reserve and fire held,
   `action` stays `'firing'` forever.

6. Pellet spread is a view-dependent box. `tracePellet` perturbs world-space
   direction components then normalizes, so the component parallel to the view
   axis is discarded and effective spread varies ~1.22× with where you look.
   Build spread in the camera-local basis with a proper disc distribution.

7. Hardcoded constants that will silently desync:
   - `Hud.tsx:7` `GRAPPLE_COOLDOWN_SECONDS = 0.35` duplicates
     `movementProfile.grappleCooldown`.
   - `GameRenderer.ts:407` hardcodes the player entity id as `1`.
   - `updateMovement`'s void check uses a stale pre-movement `position` and the
     literal `-20` instead of the existing `BOT_VOID_Y`.

=== PHASE 2 — Give the game stakes ===
8. There is no fail state. `step()` sets `locomotion = 'dead'` then immediately
   calls `restoreCheckpoint()`, which hands back >= 50 HP and keeps the score.
   `ScreenState` has no death member. Add a real death state: a death screen, a
   visible death count, and a cost for dying. Falling into the void is currently
   a silent 1.2 s fall followed by a silent teleport — fix that too.

9. The rank system is mathematically dead. All 6 kills are mandatory (600) plus
   3 encounters (450), so the minimum completion score is 1050 and
   `recordRun`'s `S` threshold is 900. Every finisher gets S forever; A, B and C
   are unreachable. Replace it with a curve tied to a par time and to combo
   performance, so ranks actually separate players.

10. `GameScreen.tsx:52` calls `recordRun(loadSave(), ...)` and throws the result
    away, so the completion overlay never shows the PB, rank or "new record" it
    just computed. Show them. Also add per-arena split times so a player can
    beat part of a run instead of only the whole thing.

11. The menu's "BEST RUN" card blends three different runs — `recordRun` takes
    `min` of time and `max` of score independently and derives rank from
    `bestScore`. Make it one coherent record.

=== PHASE 3 — Make it addicting (the actual goal) ===
12. Make the combo system real. `styles.css:366` already prints `COMBO.LINK`
    down the chain rail and `Hud` renders a 5-step CHAIN, but grep the simulation
    for combo/streak/multiplier and there is nothing — the rail is five
    independent booleans. Build a genuine flow/combo multiplier in the
    simulation: chaining traversal (dash, wall run, wall jump, grapple, vault)
    and kills without touching the ground or dropping below a speed floor builds
    a multiplier that decays when you stall. Score off it. This is what turns
    the movement kit into a reason to replay. Surface it on the existing rail.

13. Add a ghost racer. This is the highest-ROI feature available and it is
    already 90% built: the simulation is bit-deterministic from an input tape
    seeded by `hashSeed(level.id)`, proven by `tests/simulationReplay.test.ts`.
    Record the input tape of a PB run into the save, replay it as a ghost the
    player races. Keep the tape small and version it in the save schema (the
    schema is at V3 with a working migration chain in `saveStore.ts` — follow
    that pattern, do not break old saves).

14. Give the player a reason to return and a reason to choose a loadout. The gun
    builder is genuinely deep (4 chassis, 18 parts, bounded multipliers, clamped
    envelope) but nothing makes any build the right answer. Add per-run
    modifiers/challenges on a daily seed that reward specific builds and specific
    movement lines. `defaultLevel` is one 172 m linear corridor with 6 bots and
    two bot profiles that differ only in numbers — enemy variety and encounter
    variety are both worth your time here.

=== PHASE 4 — Make aiming a skill ===
15. `config.ts:33` sets `acquireCosine: Math.cos(0.8)` — a 45.8° half-angle
    acquisition cone, roughly the whole screen — and `turnRate: 22` snaps 37% of
    the remaining angle per tick, fully locking in ~80 ms. That is an aimbot, not
    aim assist. Narrow the cone substantially and replace the snap with
    rotational slowdown near a target.

16. There is no recoil in the simulation. `updateCombat` uses a fixed spread per
    shot with no accumulation, and `ViewmodelPresenter.recoil` is cosmetic — it
    never touches `player.pitch`. Add real recoil that moves the aim, spread
    bloom under sustained fire, and a recovery curve. Together with 15 this is
    where the skill ceiling comes from.

17. Crouch is a no-op below 5 m/s. `Action.Crouch` appears only in the slide
    trigger, and the player capsule (`ColliderDesc.capsule(0.55, 0.35)`) is never
    resized — so there is no crouch height and nothing to slide under. Add a real
    crouch/slide capsule, and give the slide slope acceleration so it's a
    movement tool rather than a one-shot 1.25× boost.

=== PHASE 5 — Visual pass ===
Look at `tests/e2e/visual.spec.ts-snapshots/*.png` first — that is the game as it
actually renders. Note that `art:validate` reports 1.93 MiB used of a 25.00 MiB
budget, so richness is not budget-constrained.

18. The value hierarchy is inverted. The floor is the brightest thing in frame
    (near-white `#f2f0e8`), architecture is near-black, and the enemies are deep
    teal and deep maroon — the gameplay-critical elements are the darkest things
    on screen, in fog, at `toneMappingExposure: 0.62`. Drop the floor to a
    mid-dark value and make hostiles the brightest, most saturated things in the
    frame: rim light, a fresnel outline, a constant-value silhouette that reads
    at 40 m through fog while moving.

19. Enemies read as loose primitives. In `corporate-hunters-high-chromium.png`
    the hunters have visible gaps between torso, hips and legs, detached floating
    arms and a detached floating weapon. They are 7.3k tris — there is budget to
    close the silhouette. The health bar should not be how I find an enemy.

20. There is no sense of speed, in a game about speed. Confirmed absent from the
    whole codebase: speed lines, motion blur, radial blur, chromatic aberration,
    speed-based FOV kick, depth of field. The floor is an untextured plane with
    no parallax reference, so 12 m/s and 34 m/s look nearly identical. Add, in
    this order: speed-driven FOV kick, radial speed lines keyed to
    `snapshot.player.speed`, floor detail for parallax, subtle radial blur above
    a speed threshold. All of it gated on `reducedMotion`.

21. The grapple has no affordance. `traversal.grapple` exists per primitive and
    the renderer never surfaces it, so I can't tell what's hookable until I eat a
    `grappleFail`. Highlight valid grapple surfaces when the reticle is near them
    and in range, and give the anchor asset an unmistakable emissive signature.

22. Bloom costs ~10 fullscreen passes and delivers nothing: `UnrealBloomPass` is
    at `threshold: 1.02` while `toneMappingExposure` is `0.62`, so almost nothing
    in the scene ever exceeds 1.0 post-tonemap. Either raise emissive intensities
    so bloom earns its cost, or drop to a 2-pass bloom and fold `CyberDuskGrade`
    into `OutputPass` — that's two fullscreen passes saved for free.

23. The HUD is illegible in motion: eleven simultaneous modules, including a
    12-segment speed spectrum, a 12-segment health meter, a 10-pip ammo track,
    a weapon strip and a 5-step chain rail with 5 status chips. Cut it to about
    four. Everything I need mid-flow — hit confirm, hook state, threat direction,
    combo — belongs within ~15 degrees of the crosshair. The rest is
    pause-screen information. Keep the existing accessibility work intact
    (`tests/ui.test.tsx` has 35 tests over this UI — update them, don't delete
    them).

=== PHASE 6 — Performance ===
24. Gameplay geometry isn't batched. The 78-tower skyline correctly uses
    `InstancedMesh`, but `WorldPresenter` builds a unique `RoundedBoxGeometry`
    per primitive and `GameRenderer.loadVisualAsset` adds a full `handle.scene`
    clone (3–5 meshes) per visual instance. ~30 instances of 5 unique assets is
    the textbook `THREE.BatchedMesh` case (available in three 0.185).

25. Twelve forward-rendered lights, never culled — 8 authored point/spot plus
    hemisphere plus 3 directional, all live for the whole level. It's a 172 m
    corridor; at most 2–3 authored lights can matter at once. Add distance
    culling.

26. Dynamic resolution can't react in time. `updateDynamicResolution` adjusts
    once per 120 frames in 5% steps from 1.0 to a 0.65 floor — ~28 seconds to
    reach the floor — and it averages `renderMs` only, excluding simulation,
    React and compositing, so it under-reads true cost and engages late. Use
    true frame delta, a percentile instead of a mean, and fast-drop /
    slow-recover asymmetry.

=== HOUSEKEEPING ===
27. README.md:44 claims reduced motion disables "decorative interface wipes,
    parallax, speed lines". None of the three exist. Either implement them
    (phase 5 covers speed lines) or correct the README.

Start with Phase 1. Show me the diff for each phase before moving on.
```
