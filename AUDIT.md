# Flowstate FPS — Full Sweep Audit

Baseline verified 2026-08-19 on this working tree, **before** the Phase 1 pass
recorded in section 5:

| Check | Result |
| --- | --- |
| `npm test` | 165 passed / 17 files |
| `npm run typecheck` | clean |
| `npm run art:validate` | 8 GLB + 4 KTX2 OK, **1.93 MiB of a 25.00 MiB budget** |
| Source size | ~9,286 LOC across `src/` |

The codebase is genuinely well built: clean adapter boundaries, a deterministic
fixed-step sim with replay tests, reference-counted asset cache, hash-verified
art, real accessibility work. Nothing below is about code quality. It is about
the three things that decide whether anyone plays this twice.

---

## 1. Why it isn't addicting (structural, not cosmetic)

The mechanics are the good part. `FlowSimulation` already gives you a dash-chain
with per-surface recharge, a straight-line grapple with a commit-cost pull, wall
running, wall jumps, vaults and slides. That is a real movement kit.

Everything that would make a player *use* that kit repeatedly is missing:

### 1.1 The rank system is mathematically dead **[FIXED]**
Score sources in `src/simulation/FlowSimulation.ts`:

- kill: `+100` — all 6 bots are **mandatory** (`updateObjectives` gates the exit
  on every encounter being cleared) → guaranteed **600**
- encounter cleared: `+150` × 3 → guaranteed **450**
- completion: `+max(0, 600 - elapsed)`

Minimum possible completion score is **1050**. `recordRun` in
[saveStore.ts:129](src/persistence/saveStore.ts:129) awards `S` at `>= 900`.
**Every player who finishes gets S rank on their first run, forever.** Ranks A,
B and C are unreachable dead code.

### 1.2 There is no fail state **[FIXED]**
`step()` sets `locomotion = 'dead'`, pushes a `death` event, then immediately
calls `restoreCheckpoint()` — which sets `health = Math.max(50, checkpoint.health)`
and keeps your score. Dying costs you a few seconds of walking. `ScreenState` is
`fault | complete | booting | active | standby` — **there is no death screen, no
death counter, no retry prompt, nothing.** Falling into the void at
`position.y < -20` is a silent 1.2-second fall followed by a silent teleport.

No stakes → no tension → no reason to improve.

### 1.3 The UI promises a combo system that does not exist **[FIXED]**
[styles.css:366](src/styles.css:366) prints `COMBO.LINK` down the side of the
chain rail. `Hud.tsx` renders a five-step `CHAIN` rail. Grep for `combo`,
`streak` or `multiplier` in the simulation: **nothing**. The chain rail is a
readout of five independent booleans, not a chain. The game's own HUD advertises
the retention mechanic it is missing.

### 1.4 Aiming has no skill floor and no skill ceiling **[FIXED]**
[config.ts:33](src/content/config.ts:33): `acquireCosine: Math.cos(0.8)` is a
**45.8° half-angle acquisition cone** — roughly the whole screen. `turnRate: 22`
with `blend = min(1, 22 * dt)` snaps 37% of the remaining angle *per tick*, so
the view is fully on target in about 5 ticks (~80 ms).

Meanwhile there is **zero recoil in the simulation**. `updateCombat` reads a
fixed `hipSpread`/`adsSpread` per shot with no accumulation, and
`ViewmodelPresenter.recoil` is purely cosmetic — it never touches `player.pitch`.

Net effect: hold RMB, click, win. A 720 RPM laser with a screen-wide aimbot.
There is no aim skill to express and nothing to master.

### 1.5 One 172-metre corridor **[PARTLY ADDRESSED]**
`defaultLevel` is a single linear route: 35 collision primitives, 3 arenas, 2
bots each, 6 bots total, ~2 minutes. Enemy variety is two profiles that differ
only in health/speed/range/interval numbers. Encounters activate strictly
sequentially (`updateEncounterActivation` uses `.find` on the first incomplete
encounter). After one clear there is nothing new.

**The single highest-ROI retention feature is already 90% built and unused:** the
sim is bit-deterministic (`tests/simulationReplay.test.ts` proves identical
trajectories from identical input tapes, seeded by `hashSeed(level.id)`).
Recording the input tape of a PB run is nearly free and gives you a **ghost
racer** — the mechanic that makes every movement game replayable.

---

## 2. Confirmed bugs (QA sweep)

Ordered by player impact. Every one was traced in source, not guessed.
Items marked **[FIXED]** were resolved in the Phase 1 pass; see section 5.

### P0 — Discrete input edges were silently dropped **[FIXED]**
*Found while investigating a Firefox e2e failure, not in the original read-through.*

`InputController` merged every edge in a frame into one `pressed`/`released`
mask, and `frame()` cleared it after the **first** of the fixed steps the runtime
owed. Any second press arriving before the next animation frame vanished.

`requestAnimationFrame` throttles to ~15 Hz in a backgrounded or offscreen tab.
The failing test's own debug readout proved it: `frame 1.00 ms` (frames were
cheap) but `simulation 1.00 ms (4 steps)` — four fixed steps per callback, i.e. a
67 ms rAF period. A 60 ms double tap therefore arrived entirely between two
callbacks and read as a single jump, so **the dash did not happen at all**.

Confirmed by experiment: widening the test's tap gap from 60 ms to 200 ms (past
the rAF period) made all 16 Firefox tests pass. The fix queues edges as ordered
samples the simulation drains one per step, and the test now passes at its
original 60 ms gap.

### P0 — Damage numbers and hitmarkers are on screen for ~50 ms **[FIXED]**
`GameRuntime.loop` throttles UI to 20 Hz and **empties `pendingHits` on every
push**:

```ts
if (now - this.lastUiUpdate > 50 || this.snapshot.completed) {
  this.onUpdate({ ..., hits: this.pendingHits });
  this.pendingHits = [];   // <-- next render unmounts every damage number
}
```

`Hud` renders `hits.map(...)` keyed by hit id, so 50 ms later React unmounts
them all. The CSS asks for `damage-rise .75s` and `hitmarker-pop .22s`
([styles.css:895](src/styles.css:895)) — both are truncated to ~50 ms. **The
game's primary hit confirmation is effectively invisible.** The HUD must own hit
lifetimes instead of inheriting the throttle window.

### P0 — Enemy damage is invisible, inaudible and instant **[FIXED]**
`updateBots` deals damage the moment `fireCooldown <= 0 && distance <
preferredRange * 1.5 && hasLineOfSight`. No windup, no travel time, no aim
error, no tracer, no directional indicator. Two aggressive bots are ~47 DPS
against 100 HP: dead in ~2 seconds, from nothing you could see or hear.

### P0 — Taking damage plays the *hit-confirm* sound **[FIXED]**
`updateBots` pushes a `hit` event with `targetEntityId = player.id`.
`AudioManager.consume` matches on `event.kind === 'hit'` **without checking the
target** ([AudioManager.ts:21](src/audio/AudioManager.ts:21)), so getting shot
plays the same 640 Hz square blip as landing a shot on an enemy. There is no
damage-taken sound at all. `enemyAttack`, `death`, `melee`, `reloadStart`,
`reloadComplete`, `gateOpen` and `impact` have **no audio whatsoever**.

### P1 — Taking damage spawns an impact ring inside your own camera **[FIXED]**
Same root cause: `FxPresenter.consume` treats any `hit` with a position as a
world impact, and the player's `hit` event carries `cameraPosition()`. So every
time you are shot, a red additive ring plus 6 sparks spawn at the eye origin, at
the near plane.

### P1 — Dry-firing an empty weapon locks `action` in `'firing'` forever **[FIXED]**
```ts
if (slot.ammo <= 0) {
  if (slot.reserveAmmo > 0) this.startReload(events);
  return;              // <-- skips the `action = 'neutral'` reset below
}
```
With 0 ammo *and* 0 reserve and fire held, `player.action` stays `'firing'`
indefinitely. `actionProgress()` returns 1, the HUD reads `FIRING`, and the
viewmodel keeps playing the fire clip. There is also no dry-fire click and no
empty-magazine feedback of any kind.

### P1 — Pellet spread is a box, not a cone, and its size depends on where you look **[FIXED]**
`tracePellet` perturbs the **world-space** direction components then normalizes:

```ts
x: baseDirection.x + (rand - 0.5) * spread,   // world axes, uniform, box-shaped
```

The component parallel to the view axis is normalized away, so effective angular
spread varies by up to ~1.22× with view direction, and the pattern is a uniform
box rather than a disc. Shotgun patterns are view-dependent. Spread must be
built in the camera-local basis with a proper disc distribution.

### P2 — `Hud.tsx` hardcodes a simulation constant **[FIXED]**
[Hud.tsx:7](src/game/Hud.tsx:7): `const GRAPPLE_COOLDOWN_SECONDS = 0.35;`
duplicates `movementProfile.grappleCooldown`. Tuning the profile silently
desyncs the cooldown meter.

### P2 — The renderer hardcodes the player entity id **[FIXED]**
[GameRenderer.ts:407](src/render/GameRenderer.ts:407):
`(event.targetEntityId ?? event.entityId) === 1`. True only because
`nextEntityId` starts at 1 and the player is created first. Should read
`snapshot.entities[0].id`.

### P2 — Void-death check reads a stale position and duplicates a constant **[FIXED]**
`updateMovement` captures `position` before moving, then tests
`if (position.y < -20)` at the bottom — one tick late — using a literal instead
of the existing `BOT_VOID_Y = -20`.

### P2 — A shotgun blast saturates the entire spark pool **[FIXED]**
`spawnImpact` emits 6 sparks per impact; the shotgun fires 8 pellets. The pool
is 48 (`FxPresenter.createPools`), so a single shell fills it exactly and
`acquire` starts stealing live slots via `pool[cursor++ % length]`. Shotgun
impacts look strictly worse than rifle impacts.

### P2 — Crouch does nothing unless you are already sprinting **[FIXED]**
`Action.Crouch` appears in exactly one place: the slide trigger, gated on
`speed > 5` and grounded. The player capsule is **never resized**
(`ColliderDesc.capsule(0.55, 0.35)` is created once and never touched), so there
is no crouch height, no slide-under geometry, and no low profile. `C`/`Ctrl` is
a no-op at low speed.

### P3 — `recordRun` writes the save but never updates React state **[FIXED]**
[GameScreen.tsx:52](src/game/GameScreen.tsx:52) calls
`recordRun(loadSave(), ...)` and discards the result, so the local `save` is
stale on the completion screen. The completion overlay consequently shows no PB
comparison, no rank, and no "new record" — the three numbers `recordRun` just
computed are never shown to the player.

### P3 — The "BEST RUN" card blends three different runs **[FIXED]**
`recordRun` takes `min` of time and `max` of score independently, and derives
`rank` from `bestScore`. The menu presents them as one run with one rank.

### P3 — `Action.Dash` is unreachable from the keyboard
`keyActions` in `InputController` has no `Dash` binding (by design — it's derived
from a double-tapped jump), but the action bit exists and only tests use it.
There is also **no key rebinding and no gamepad support**, and `ControlRight` is
missing while `ControlLeft` is bound.

### P3 — README documents three features that don't exist
[README.md:44](README.md:44) claims reduced motion "disables decorative
interface wipes, parallax, speed lines". Grep: **none of the three are
implemented anywhere.**

---

## 3. Visual optimization plan

Grounded in the committed visual-regression snapshots
(`tests/e2e/visual.spec.ts-snapshots/`), which are the game as it actually looks.

### 3.1 The value hierarchy is inverted **[FIXED — see section 11; the diagnosis below is wrong]**
The albedo framing in this entry does not hold up; see section 9 for the measured
correction. Kept as written for the record.

#### Original entry
The floor is the **brightest** surface in frame (near-white `#f2f0e8` rooftop
platforms), the architecture is near-black, the sky is dark magenta — and the
enemies are **deep teal and deep maroon**. Everything gameplay-critical is the
darkest thing on screen, sitting against dark architecture, in `FogExp2` at
`toneMappingExposure: 0.62`.

Fix: drop the floor to a mid-dark value, and make hostiles the brightest,
highest-saturation elements in the frame. Rim light + a fresnel outline pass +
constant-value silhouette so a hunter reads at 40 m through fog while you are
moving at 20 m/s.

### 3.2 Enemies do not render as characters at all **[FIXED — and this was a bug, not art]**
**This entry was wrong when written.** I described "visible gaps between torso,
hips and legs" and treated it as art quality. Zooming the baseline showed the
hunters were fully **disassembled**: a floating helmet, a torso with no arms,
arms hovering a metre away, the weapon detached, and the legs as two loose
cylinders on the floor. The live game rendered the same thing. See section 9.

### 3.3 There is no sense of speed — in a game about speed **[FIXED]**
Confirmed absent from the entire codebase: speed lines, motion blur, radial
blur, chromatic aberration, speed-based FOV kick, depth of field. The only
vignette is the health vignette. The floor is a large untextured plane with no
high-frequency detail, so there is **no parallax reference** — at 12 m/s and at
34 m/s the screen looks nearly identical.

Fix, in priority order: speed-driven FOV kick → radial speed lines keyed to
`snapshot.player.speed` → floor detail/edge lines for parallax → subtle radial
blur above a speed threshold → grapple-specific tunnel effect. All of it must
respect the existing `reducedMotion` setting, which already has the plumbing.

### 3.4 The grapple has no affordance **[FIXED]**
The grapple is the signature mechanic and `traversal.grapple` already exists per
primitive — but **the renderer never surfaces it**. Players cannot tell what is
hookable until they try and eat a `grappleFail`. Anchors in `defaultLevel` sit at
y = 12–14 and are visually indistinguishable from the black skyline.

Fix: highlight valid grapple surfaces when the reticle is near them and range is
satisfied; give the anchor asset an unmistakable emissive signature.

### 3.5 The bloom pays for itself and delivers nothing
`UnrealBloomPass` runs 5 mip levels of separable blur (~10 fullscreen passes) at
`threshold: 1.02` — but `toneMappingExposure` is `0.62`, so almost nothing in the
scene ever exceeds 1.0 post-tonemap. Bloom effectively only catches the
`toneMapped: false` FX materials, at `strength: 0.18`.

Either raise emissive intensities so bloom earns its cost, or replace it with a
2-pass bloom and fold `CyberDuskGrade` into `OutputPass` (two fullscreen passes
saved for free).

### 3.6 The HUD is unreadable in motion
Eleven simultaneous modules: objective, crosshair, lock indicator, hitmarker,
damage layer, grapple readout, telemetry (elapsed + score + locomotion label +
speed + 12-segment spectrum), health module (heading + value + 12-segment
meter), ammo module (heading + value + weapon strip + 10 pips + reload track),
threat readout, and a 5-step chain rail with 5 status chips.

It photographs beautifully and is illegible at 20 m/s. Everything the player
actually needs mid-flow — hit confirm, hook state, threat direction, combo —
belongs within ~15° of the crosshair; the rest is pause-screen information.

### 3.7 There is 23 MB of unused art budget **[PARTLY — city density added, see section 11]**
`art:validate` reports **1.93 MiB of 25.00 MiB**. Visual richness is not
budget-constrained. The whole 172 m route is built from 5 environment assets
with 4 material variants and 3 route signs as the only landmarks.

### 3.8 Draw calls: gameplay geometry is not batched **[PARTLY — see section 10]**
The 78-tower skyline correctly uses `InstancedMesh`. The **gameplay** geometry
does not: `WorldPresenter` builds a unique `RoundedBoxGeometry` per primitive,
and `GameRenderer.loadVisualAsset` adds one full `handle.scene` clone per visual
instance (3–5 meshes each). ~30 instances of 5 unique assets is the textbook
case for `THREE.BatchedMesh` (available in three 0.185).

### 3.9 Twelve forward-rendered lights, never culled **[FIXED]**
8 authored point/spot lights + hemisphere + 3 directional, all live for the
whole level with no distance culling. On a forward renderer this is the dominant
fragment cost on integrated GPUs. The level is a 172 m corridor — at most 2–3
authored lights can matter at once.

### 3.10 Dynamic resolution cannot react in time **[FIXED]**
`updateDynamicResolution` adjusts once every **120 frames** in 5% steps from 1.0
to a 0.65 floor: 14 adjustments ≈ **28 seconds** to reach the floor. Worse, it
averages `renderMs` only — excluding simulation, React and compositing — so it
systematically under-reads true frame cost and engages late. It needs true
frame-to-frame delta, a percentile rather than a mean, and a fast-drop /
slow-recover asymmetry.

---

## 4. Sequencing

**Phase 1 — Make it feel fair (do this first; nothing else matters without it)**
Damage-number/hitmarker lifetime · damage-taken audio + directional indicator ·
enemy telegraph (windup + tracer) · camera-space pellet spread · remove the
camera-origin impact · dry-fire fix + click · fix the hardcoded constants.

**Phase 2 — Make it a game with stakes**
Real death state and death screen · death counter · rank curve tied to a par
time · per-arena split times · PB comparison on the completion screen.

**Phase 3 — Make it addicting**
Combo/flow multiplier that makes the HUD's `COMBO.LINK` real · ghost replay from
deterministic input tapes · seeded daily variant · reasons to pick a loadout.

**Phase 4 — Make aiming a skill**
Real recoil that moves the aim · spread bloom and recovery · aim assist reduced
from lock to assist (narrow cone + slowdown, not snap).

**Phase 5 — Visual pass**
Value hierarchy · enemy readability · speed feedback · grapple affordance ·
HUD reduction to 4 modules · spend the 23 MB.

**Phase 6 — Performance**
BatchedMesh for static geometry · light culling · post-stack consolidation ·
responsive dynamic resolution.

Phases 1–2 are correctness and can ship independently. Phase 3 is where the
retention actually comes from. Phases 5–6 are safe to run in parallel with 3–4
because the render adapters own no gameplay state.


---

## 5. Phase 1 status — complete

Verified on this tree: `npm test` **177 passed / 18 files**, `npm run typecheck`
clean, `npm run build` clean, `npm run test:e2e` **35 passed** (twice,
Chromium + Firefox), 3 Chromium visual baselines unchanged, `npm run art:validate`
clean at 1.93 MiB of 25.00 MiB.

Landed:

- **Feedback owns its own clock.** Hit lifetimes moved out of the 20 Hz UI
  throttle into `GameRuntime`, which now retains hits in *world space* and
  re-projects them every update, so a damage number stays pinned to the enemy for
  its full 780 ms float. Hits on one target inside 260 ms merge into the number
  already on screen, so a 1020 RPM weapon reads as one climbing number.
- **Enemy fire is a two-stage, traced shot.** Bots commit, emit `enemyTelegraph`,
  and only then resolve a real trace from their muzzle. Breaking line of sight
  during the window defeats the shot, and aim error scales with player speed — so
  the movement kit is now the defence. Shot-to-shot cadence is deliberately
  unchanged: the telegraph buys reaction time, it is not a hidden DPS nerf.
- **The mix distinguishes damage dealt from damage taken.** Rebuilt
  `AudioManager` around a master bus, a deterministic noise source, distance
  attenuation and stereo placement. Damage taken is a noise thud plus a falling
  tone; it can no longer be confused with the hit-confirm blip. `enemyTelegraph`,
  `enemyAttack`, `death`, `melee`, `dryFire`, `reloadStart`, `reloadComplete` and
  `gateOpen` all have sound for the first time.
- **A threat compass** replaces the impact ring that used to detonate inside the
  player's own near plane, so incoming fire is locatable.
- **Camera-space pellet cones** with a uniform disc distribution, replacing the
  world-axis box whose size varied with view direction.
- Dry-fire clicks once per trigger pull and no longer strands `action` in
  `'firing'`; the three hardcoded constants are gone; the spark pool no longer
  eats itself on a shotgun shell.

New tests: `tests/combatFeedback.test.ts` (7, telegraph/miss attribution/dry
fire/cone geometry), 3 HUD threat-compass cases in `tests/ui.test.tsx`, 2 input
edge-queue cases in `tests/inputController.test.ts`.

Two defects were found *by* the new tests rather than by reading: holding the
trigger through the last round produced no dry-fire click at all, and the bot
cadence comment did not match its code (the telegraph was being added on top of
the fire interval, halving bot DPS by accident). Both corrected.


---

## 6. Phase 2 status — complete

Verified: `npm test` **197 passed / 19 files**, `npm run typecheck` clean,
`npm run build` clean, `npm run test:e2e` **35 passed** (Chromium + Firefox),
3 Chromium visual baselines unchanged, `npm run art:validate` clean. Both new
screens were also checked in a real browser, not only through DOM assertions.

Landed:

- **Death is now a state the player leaves.** `step()` no longer restores the
  checkpoint on the tick you die. The player goes down, the run clock **freezes**,
  and a HUD-level panel asks for `Space`/`LMB` to redeploy — kept in the HUD
  rather than an overlay so Pointer Lock is never released and flow resumes
  instantly. Respawn returns full health.
- **Dying costs something.** A fixed `deathTimePenaltySeconds` (5 s) is charged to
  the clock at the moment of death. Charging time rather than score means it
  cannot be waited out on the death panel and cannot be laundered by a checkpoint
  restore the way a score penalty would; because the completion bonus is
  `budget - elapsed`, it costs score automatically through one mechanism instead
  of two.
- **A death counter** that survives checkpoint restores, shown live in the HUD
  telemetry, on the completion screen, and stored with the record.
- **The rank curve actually separates players.** `rankRun` grades elapsed time
  against `runScoring.parSeconds` *and* gates on deaths: S needs par with zero
  deaths, A allows 1.25× par and one death, B 1.6× par and three. The old curve
  compared the all-time best score against a threshold every clear exceeded.
- **The completion screen reports the grade it computes.** `GameScreen` keeps the
  `recordRun` result instead of discarding it, so the screen shows the rank, a
  signed score/time delta against the previous best, a `NEW BEST RUN` /`FASTEST`
  flag, and per-arena splits with per-split deltas.
- **Per-arena split times** recorded in the simulation at each cleared encounter,
  pruned correctly on a checkpoint restore, emitted as a `split` event, surfaced
  live in the HUD and stored on the record so a player can beat part of a run.
- **One coherent record.** Save schema V4 replaces the three independent
  `bestTimeSeconds`/`bestScore`/`rank` fields with a whole `bestRun` record;
  fastest clear stays tracked but is labelled separately instead of being folded
  into a card that described three different attempts. V1–V3 saves migrate, with
  the legacy fields reconstructed as one record.
- Audio for `death`, `respawn` and `split`.

New tests: `tests/runProgression.test.ts` (10 — death state, frozen clock,
penalty charged once, respawn inputs, deaths across respawns and restores, falling
out of the level, splits and their restore behaviour), 7 HUD/completion cases in
`tests/ui.test.tsx`, 4 record cases in `tests/saveStore.test.ts`.

`tests/grappleSimulation.test.ts`'s death case was rewritten rather than
deleted: it now asserts the rope drops on death *and* that redeploying hands back
a hook with its cooldown cleared, which preserves the original intent under the
two-stage death.

A test caught a wrong assumption of mine: I first asserted the death count
survived a restore using a level whose checkpoint was itself lethal, so the count
legitimately incremented again. Rewritten against a level the player can be walked
off, which also gave real coverage of falling out of the world.


---

## 7. Phase 3 status — combo and ghost complete, content variety not attempted

Verified: `npm test` **233 passed / 22 files**, `npm run typecheck` clean,
`npm run build` clean, `npm run test:e2e` **35 passed** (Chromium + Firefox),
3 Chromium visual baselines unchanged, `npm run art:validate` clean. The chain
readout, the ghost, the daily contract and the record card were all checked in a
real browser.

### The flow chain is real
The HUD had been printing `COMBO.LINK` down a rail that reported five independent
booleans. It now reports an actual chain: air dash, wall-run entry, wall jump,
vault, hook, hook pull and kills all link, each link raises a multiplier that
every award is scaled by, and the chain lapses 2.5 s after the last link.

Two rules keep it from being farmable, and **the second only exists because a test
found the hole**:

1. Each movement tech links at most once per chain, so growing a chain means
   reaching for a different tool. Only kills repeat, and they are bounded by the
   number of hostiles.
2. An isolated link pays nothing — scoring starts at the second link.

My first implementation had only an informal version of rule 1 and I reasoned in a
code comment that the air-charge economy bounded dashes. It does not: it bounds
them *per air time*, and air time is freely repeatable. Jump, air dash, land to
recharge, repeat gave an unbounded chain worth ~60 points a second standing still.
The anti-farm test now drives 700 ticks of exactly that cycle and asserts the peak
chain stays at 1 and the score never moves.

Peak chain also gates the top ranks, so S now requires having used the kit rather
than merely walking the route quickly.

### The ghost racer records a path, not an input tape
**This deviates from what section 1.5 proposed, deliberately.** An input tape has
to be re-simulated, which needs a second Rapier world every frame *and* identical
initial conditions: `updateLook` scales raw mouse deltas by
`settings.sensitivity`, and the loadout decides when bots die, which decides when
gate colliders disable, which changes where the player can go. Any of those
drifting desyncs the ghost silently.

A recorded path is smaller, costs no simulation, and cannot desync. Re-simulation
buys nothing a ghost needs, because a ghost only ever has to show where the record
was at a given moment. Determinism is still what makes the recording faithful; it
just does not have to be re-derived at runtime.

- Sampled at 20 Hz against the **run clock**, not the tick count, so the recording
  does not depend on the frame rate that produced it, and a frozen or penalty-jumped
  clock fills slots rather than leaving gaps.
- Quantized to centimetres; a 150 s run is roughly 40 KB.
- Tied to a level id, so a path from another route is never replayed.
- The delta is measured by finding the point on the path closest to where the
  player is *now* and comparing clock readings — comparing positions at equal time
  would only report how far apart they are, which says nothing about who is ahead.
  A second test caught that my search window bounded how far the match could snap
  backwards but did not stop it: on a route that doubles back, two points were
  equidistant and the earlier one won, reporting a full second of lead that was
  never earned. The tracker now prefers forward progress.
- The ghost fades out inside 1.6 m. Being level with the record is the good case,
  and an additive blob at arm's length would blind the player for achieving it.

### Daily contracts give a reason to return and a reason to pick a build
Four contracts, chosen from the local date so everyone racing on a given day races
the same rules, surfaced on the menu, in the pause brief and on the HUD. Two of
them pay double for specific chassis, which is the first thing in the game that
makes any armory build the right answer. Each also bends the bot profiles
multiplicatively, so an authored profile stays the source of truth. Bonuses are
additive fractions and asserted non-negative, so a contract can never make a run
worth less than an unmodified one. A ghost is only raced against a run set under
the same contract.

### Not attempted: enemy and encounter variety
Section 1.5's other half is untouched, and I would rather say so than bolt on
something thin. The route is still one 172 m corridor with six bots of two
profiles.

Adding a third bot profile means touching `SpawnDefinition['kind']` and the level
schema, the editor's bot-assignment UI, and `CharacterPresenter`'s profile→template
mapping — and there are only two hunter GLBs, so a third type would reuse a model.
More importantly, the audit's criticism was that the two existing profiles "differ
only in health/speed/range/interval numbers"; a third that also only differs in
numbers would not answer it. Real enemy variety wants a *behaviour* (a shielded
type that must be flanked, a flyer that breaks the ground fight) and probably new
art — of which there is budget for plenty, at 1.93 MiB of 25 MiB. Encounter
variety is level authoring that wants playtesting against the new chain rules,
which have only just started existing.

New tests: `tests/comboChain.test.ts` (9), `tests/ghostTrack.test.ts` (13),
`tests/runModifiers.test.ts` (8), plus 5 HUD cases in `tests/ui.test.tsx`.


---

## 8. Phase 4 status — complete

Verified: `npm test` **250 passed / 23 files**, `npm run typecheck` clean,
`npm run build` clean, `npm run test:e2e` **35 passed** (Chromium + Firefox),
3 Chromium visual baselines unchanged, `npm run art:validate` clean. Recoil, bloom
and the crouch were also driven in a real browser.

### Aim assist is an assist now
The old profile acquired inside a **45.8 degree half-angle** — roughly the whole
screen — and converged exponentially, closing 37 per cent of the remaining angle
every tick, so it was fully on target in about 80 ms. Replaced with the
console-standard pair:

- **A narrow cone**: about 8 degrees to acquire, 13.75 to hold.
- **Slowdown**: the player's own look input is damped to as little as 55 per cent
  with a target centred. This is the assist — it makes a target easier to hold and
  never moves the crosshair for anyone.
- **A rate cap** on what the assist may move itself: 0.35 rad/s, scaled by how
  centred the target is. A bounded rate can settle a shot the player has already
  lined up; it cannot cross the screen and acquire one for them.

`tests/controlScheme.test.ts`'s two contradicted cases were rewritten rather than
deleted: the one that asserted the view got *steered onto* the target now asserts
bounded movement toward it that does not cover the gap, and the one that asserted
a target 40 degrees off centre still locked now asserts it does not. A new case
covers the slowdown directly.

Reordering the resolve to run before the look introduced a one-tick lag in the
lock the HUD reported, which the existing "drops targets that leave the hold cone"
test caught. The lock is now re-validated against the view the tick actually ended
on.

### Recoil moves the aim
`ViewmodelPresenter.recoil` was cosmetic and never touched `player.pitch`, so the
weapons were laser pointers. Now every shot kicks the **aim**, the kick is
recorded, and recovery hands back *only what recoil added* — so a correction the
player made while fighting the climb survives instead of being undone by the
settle. Six new stats per chassis, clamped in `STAT_LIMITS`, and grips, stocks and
barrels now shape the climb, which is the first time those slots have done what
their names imply.

Recovery is suspended for 120 ms after each shot. Without that hold, any rate fast
enough to settle between bursts also cancels the kick inside one and no learnable
pattern forms. **A test then found the identical bug in spread bloom** — at 720
rounds a minute the shed rate outran the per-shot gain and bloom never formed at
all — so bloom is held on the same window. The per-chassis consequences fall out
correctly: a pump shotgun never blooms, and a DMR punishes fast-clicking.

The crosshair opens with the bloom, because firing into a widened cone was
otherwise invisible.

### Crouch is real
`Action.Crouch` previously appeared in exactly one place — the slide trigger,
gated on speed — and the capsule was created once and never touched, so `Ctrl` did
nothing below sliding speed and there was nothing to slide under. Now:

- The collider actually shrinks, interpolated rather than snapped.
- The eye drops with the stance.
- Crouched movement has its own speed cap and ignores sprint.
- Standing up is **refused while there is no headroom**, so a player who slid
  under geometry cannot pop through it.
- Sliding gains speed downhill, from a probed ground normal, which turns the slide
  from a one-shot 1.25x boost into a movement tool — and gives the chain another
  way to stay alive.

New tests: `tests/recoilAndStance.test.ts` (15), plus 3 rewritten and 1 new case in
`tests/controlScheme.test.ts`.

A second test bug of mine: the slide-slope case rotated a 60 m ramp about a centre
30 m from the spawn, which put the surface metres away from the player, so the
slide never started. Rotating a box about its own centre leaves that point fixed,
so the ramp is now centred on the spawn.


---

## 9. Phase 5 status — a P0 asset bug found and fixed; two visual items not done

Verified: `npm test` **250 passed**, `npm run typecheck` clean, `npm run build`
clean, `npm run test:e2e` **35 passed**, `npm run art:validate` clean, and the
3 Chromium visual baselines **regenerated** against the rebuilt art.

### The characters were not rendering as characters

Section 3.2 originally called this an art-quality problem. It was a pipeline bug,
and a worse one than I described. Diagnosis, in order:

1. Zooming the committed baseline showed the hunters fully disassembled, and the
   live game matched. So it shipped that way.
2. The GLB reported **`skins: 0`** with 11 animation clips targeting an armature
   (`pelvis`, `spine`, `arm_l`…). The mesh nodes were **siblings** of the bone
   chain, at `z` offsets fanned from 0.43 m to 1.66 m — hence the exploded look —
   and nothing followed the bones, so all 11 clips were inert.
3. `generate_vertical_slice.py` rigid-parents each piece to a bone correctly, and
   then `collapse_by_material` joins pieces for batching. Its own docstring says
   joining across bones makes actions inert and that the bone therefore belongs in
   the batching key — and the code does that. **The script was already fixed; the
   assets were never rebuilt.** The `.blend` sources were 2½ hours older than the
   script.

`npm run art:build` regenerates everything from source, so the fix was to run it.
The hunters now carry 22 mesh nodes correctly parented across head, spine, arms,
legs and pelvis, and render as coherent figures.

Two follow-ups so this cannot recur silently:

- **A new validator rule.** `validation.minimumRigAttachments` asserts geometry
  hangs off at least N distinct rig nodes. The existing per-clip binding checks
  could not catch this: every clip animates the shared `root`, and `root` is an
  ancestor of everything, so "this clip controls an ancestor of rendered geometry"
  was satisfied by root motion alone.
- **`hunter_land` was genuinely inert** and the rebuild surfaced it. Its motion
  used `sin(pi t)`, which is zero at both sampled endpoints. It now starts
  compressed and recovers, which is both measurable and what a landing looks like.

**The visual regression suite could not have caught this.** The hunters occupy
3–4% of the frame and `maxDiffPixelRatio` is `0.035`, so a total character failure
passed by a hair. Measured explicitly: 27,580 px (3.0%) and 31,458 px on the
hunters shot. The deterministic asset check above is the right guard; tightening a
whole-frame pixel ratio to catch a 3% region would be flaky. The baselines had also
drifted to stale-but-passing and were regenerated from scratch.

### Landed

- **Grapple affordance.** The simulation now publishes where a cast would land and
  whether it would be accepted, from the same raycast the press uses, so the
  preview cannot disagree with the result. A ring is drawn on the surface — cyan
  when the cast would be taken, dim red when it is inside the minimum range.
  `traversal.grapple` had existed all along with nothing surfacing it.
- **Speed cues.** A speed-driven FOV kick, plus radial smear, radial dispersion and
  an edge close-in folded into the existing grade pass, so they cost **no extra
  fullscreen pass**. Both gated on `reducedMotion` and scaled by graphics quality,
  and suppressed while aiming, where a widening frame fights the zoom. Measured: at
  the 11 m/s threshold the frame edge darkens 8.5%.

### Not done, and why

- **3.1 value hierarchy.** I wrote a material grade to pull bright environment
  albedo down and lift hostile armour, then measured it: **identical pixels, both
  times.** The audit's diagnosis was wrong. The floor is not bright because of its
  albedo — measured at rgb(58,77,85), which is not bright — it is bright because
  the sun rakes across it while everything else sits in shadow. This is a lighting
  balance task, not a material one, and it is a subjective art call with real
  regression risk. I reverted both functions rather than leave code that looks like
  a fix and changes nothing.
- **3.6 HUD reduction.** Not attempted, and the HUD is now *denser* than when the
  audit was written, because phases 2–4 added deaths, splits, the ghost delta, the
  chain readout, the threat compass and the contract label to it. That makes the
  item more pressing, not less. It is a large, subjective redesign across ~44 UI
  tests and wants its own pass.
- **A misstep worth recording.** I moved the grade pass after `OutputPass` on the
  theory that grading display-referred values is more correct. It is, but the
  grade's tuning was built against linear input, and post-tonemap the same filmic
  curve lifts mid tones instead of crushing highlights — the whole route washed
  out. Reverted, with the reasoning left in the source comment.


---

## 10. Phase 6 status — measured, and one item deliberately left

Everything here was measured before and after, because two of the Phase 5 changes
turned out to alter no pixels at all. Verified: `npm test` **262 passed / 24
files**, `npm run typecheck` clean, `npm run build` clean, `npm run test:e2e`
**35 passed**, 3 Chromium visual baselines pass, `npm run art:validate` clean.

### Baseline
`326 draw calls` — measured as **250 main pass + 76 shadow pass** from 264 visible
meshes, with 135 of them requesting `castShadow`. 141,963 triangles. Eight authored
point/spot lights, all live, at distances of 74, 95, 127 and 161 m from origin with
ranges of 13 to 28 m.

### Lights: 8 live → 3 pooled
Every light three.js can see enters the uniform arrays and the per-fragment loop of
every lit material. `WorldPresenter` now keeps a **fixed pool** of 2 point + 1 spot
and assigns the nearest reachable authored definitions to it each frame; unused
slots idle at zero intensity.

The pool size is fixed rather than lights being toggled because three.js rebuilds
shader programs when the light *count* changes — hiding a light would trade a
steady cost for a hitch every time one came into range. Measured across the route:
**3 lights in the list, 1–2 contributing, program count steady at 47** while
moving, so no recompile churn. A light beyond its `distance` already contributed
nothing, so culling on `distance - range` is exactly the falloff three.js applies —
the baselines confirm the lighting result is unchanged.

Gate-bound lights are now handled by exclusion from the pool rather than by
toggling `visible`, which was itself a recompile trigger.

### Dynamic resolution: ~28 s to react → under 1 s
Extracted into `src/render/ResolutionController.ts` as pure, testable logic. The
old controller re-evaluated once per 120 frames in 5% steps from 1.0 to a 0.65
floor — fourteen adjustments — and averaged only `renderMs`, excluding simulation,
React and compositing, so it under-read the real cost of a frame. The new one:

- samples the **true frame delta**, not the renderer's slice of it;
- decides on the **90th percentile** of a 20-frame window, so a burst of good frames
  cannot hide a bad run, and an isolated hitch does not trigger a drop;
- is **asymmetric** — 12% drop steps, 3% recovery steps — so it protects the budget
  quickly and gives resolution back gently, with a gap between the thresholds so it
  cannot chatter.

12 tests cover it, including that it reaches the floor in under two seconds of
frames and returns to 1.0 once load lifts.

### Shadow casters: 326 → 290 draw calls
Every aligned visual in `defaultLevel` requested `castShadow`, including the large
horizontal decks. Under an overhead sun a deck casts onto itself. Decks now
receive but do not cast; uprights — walls, barriers, anchors — still cast.

Measured: **total 326 → 290, shadow pass 76 → 40, casters 135 → 75.** Verified
invisible by tightening `maxDiffPixelRatio` to force a report: **93 pixels and 5
pixels** differ out of 921,600.

### Not done: `BatchedMesh` for the catalog assets
The main pass is 250 draw calls from 264 visible meshes — essentially 1:1, so the
audit's observation stands. I did not do it, for two reasons:

1. **The refactor is substantial, not mechanical.** `BatchedMesh` needs one material
   per batch, and the environment assets carry 3–5 each. Worse,
   `applyMaterialVariant` clones materials *per instance* to tint accents, and every
   aligned visual carries a `materialVariantId`. Batching means grouping by
   (asset, variant), building one shared material per group, and rerouting
   per-instance visibility for the gate bindings through `setVisibleAt`.
2. **I cannot demonstrate the benefit here.** Frame time measures ~1.2 ms in this
   environment; the game is not draw-call bound on this machine. Trading real
   regression risk against an unmeasurable gain is the mistake I already made once
   this session, and 250 draw calls is high-ish rather than pathological.

It is worth doing on a machine where the cost is visible, with the numbers above as
the baseline to beat.


---

## 11. Palette, value hierarchy and city density

### The 3D layer now matches the interface
The menu and boot screens are flat blocks of pure yellow, cyan and hot pink over
near-black, and that is the game's identity. The 3D layer had drifted: forty-odd
hand-written hexes, all near the palette and none on it, a lot of soft ambers and
salmons, and **no yellow at all** -- the one colour the interface leads with.
`src/render/palette.ts` is now the single source of truth for scene void, fog,
surface accents, hostile accents and every emissive material.

### The value hierarchy, correctly diagnosed this time
Section 3.1 blamed albedo and section 9 recorded that a runtime material grade
changed no pixels. Both were built on a broken measurement -- see below. The real
cause was the **deck top's albedo at source**, linear (0.28, 0.34, 0.38), which made
the play surface the brightest thing in the game. Fixed in
`generate_vertical_slice.py` and rebuilt, with the sun cooled and pulled back from a
warm 2.05 and exposure lowered to 0.52. The architecture is now dark and the
emissive trim carries the brightness.

Hostiles also accent their **signal trim only**. Making every material on the model
emissive is why a hunter read as a glowing blob rather than a silhouette with a
marking, and it was part of why enemies were hard to pick out at all.

### City density
Towers started 42 units out while the play corridor is 17 wide, leaving a 25-unit
dead band either side of the route, and each tower carried one emissive strip. Now
there is a near tier filling that band, a far tier behind it for depth, three
coloured neon bands and a vertical sign per tower, and gantries crossing overhead so
the upper half of the frame is not empty sky. All instanced: the whole city costs
**2 draw calls** — 290 to 292 total, 140k to 163k triangles.

### My measurement harness was wrong, and it cost real time
Two mistakes compounded:

1. **`sharp`'s `stats()` reads the input image and ignores a pending `.extract()`.**
   Every "region" reading I took in Phase 5 was a whole-frame mean. The conclusion in
   section 9 that the environment grade and hostile lift "changed no pixels" was
   therefore under-supported — a regional change could hide in a frame-wide average.
   Those two functions were still the wrong fix for the right problem, and the
   source-level fix above is the correct one, but the evidence I gave was not.
2. **Screenshots taken ~2.2 s after entering a run race the async asset load.** The
   frame renders pale and washed before the KTX2 sheets and character GLBs settle. I
   spent a long stretch bisecting a rendering "regression" that was entirely this,
   including reverting a debug spawn position on a diagnosis that was simply wrong.
   Measured directly: the same scene reads rgb(197,214,210) at 2.2 s and
   rgb(31,39,45) at 6 s. The visual-regression suite was never affected because
   `openPresentation` waits on the asset responses before capturing — which is why
   its baselines stayed trustworthy throughout.

Verified: `npm test` **262 passed**, typecheck clean, build clean, `test:e2e`
**35 passed**, `art:validate` clean, 3 visual baselines regenerated and re-checked.

### Still outstanding
`BatchedMesh` batching of the catalog assets (section 10), the HUD reduction
(section 9), and enemy/encounter variety (section 7). None were attempted here.
**All three are done in section 12.**


---

## 12. The three remaining items

Verified: `npm test` **285 passed / 26 files**, `npm run typecheck` clean,
`npm run build` clean, `FLOWSTATE_STATIC_DIST=1 npm run test:e2e` **35 passed**
(Chromium + Firefox), `npm run art:validate` clean at 1.93 MiB of 25.00 MiB, and the
3 Chromium visual baselines pass -- with the hunters one **regenerated**, for a
reason worth reading in the last subsection.

### The HUD: 13 modules to 6, in four zones

`.hud` had **12 unconditional children** (plus a hitmarker, a lock indicator and the
down panel) and rendered roughly 13 readouts. It now has **8**, of which six are
readouts a player acts on:

- **Inside ~15 degrees of the crosshair** -- hit confirm, damage numbers, threat
  bearing, ghost delta, hook state, chain multiplier and its window. At 1280x720 and
  a 92-degree vertical FOV, fifteen degrees is 93 px; measured, the flow row sits
  32-54 px below the reticle and no wider than 56 px either side (9.2 degrees), and
  the ghost delta 82 px above it (13.3 degrees).
- **Two corners** -- one health number, one ammo number with the live weapon named
  above it and the reload track under it.
- **One top bar** -- objective, hostiles left, run clock, the day's contract.
- **The pause screen** -- elapsed, score, deaths, hostiles, peak chain, the vitals
  meter, the carried-weapons strip and the splits so far, in a new `RunStatusPanel`.

The redundancy the audit named is gone: health was a number *and* a twelve-segment
meter, ammo a number *and* ten pips *and* a weapon strip, speed a number *and* a
twelve-segment spectrum, and the five chain chips reported availability the combo
multiplier already implies. Also gone: the `FLOW/STATE // KINETIC COMBAT OS` wordmark
printed across the top left of the HUD, and the frame notches.

Two deliberate deviations from the brief, both because the run is scored on the
clock: the **run clock** stays, folded into the top bar rather than sent to the pause
screen, and the **hostiles left** count stays, as a chip on the same bar instead of
its own panel. Neither costs a module.

`Hud.tsx` went 174 -> 154 lines and `styles.css` 1034 -> 972, with **141 dead rules
removed** across the four layers that had accumulated overrides for modules that no
longer exist. `StatusChip` went with them; the chain rail was its only caller.

The 44 UI cases were updated rather than deleted, and `tests/ui.test.tsx` is now 53:
the accessibility work survived intact (`aria-label` on the hook state, the ammo
value announcing magazine capacity, the health value announcing its maximum), and
four new cases assert what the reduction actually removed.

Checked at 1280x720 in Chromium, not only through the DOM. That turned up something
the DOM could not: the standby card is also the pause screen, and adding the run
telemetry to it pushed `Enter run` under the fold. It was already 39 px under it
before this pass; the short-viewport rules now leave 25 px of overflow with the
button **visible without scrolling**.

### Catalog geometry: 292 draw calls to 152

Measured at the spawn view, 1280x720, high quality, with `renderer.info` and by
toggling `shadowMap.enabled` and `assetRoot.visible` for a frame:

| | draws | main | shadow | triangles |
| --- | --- | --- | --- | --- |
| before | 292 | 252 | 40 | 163,219 |
| after | **152** | **138** | **14** | **163,219** |

`assetRoot` alone went from **132 main-pass draws + 39 shadow** (from 132 meshes
across 35 instances, essentially one draw per mesh) to **18 + 13**. Frame time here
is ~1.2 ms and was not the point; the draw-call reduction is.

`BatchedMesh`, and the deciding number was not the draw count -- merging, instancing
and batching all win the same 18 groups -- but the geometry each submits:

| spawn / finish view | draws | triangles |
| --- | --- | --- |
| unbatched | 292 / 64 | 163,219 / 81,339 |
| merged or instanced | 152 / 55 | 175,991 / 120,067 |
| `BatchedMesh` | 152 / 55 | 163,219 / 81,339 |

The audit expected per-instance culling to buy almost nothing on a 172 m corridor.
At the spawn view that is nearly true: every asset mesh is in front of the camera and
drawn either way. Standing at the finish with the route behind you it is not --
culling was skipping 38k triangles, and any batch culled as a single unit hands them
all back. `BatchedMesh` keeps the per-instance test *and* collapses the calls, so it
is the only option that costs nothing to take.

Three things made the grouping tractable, and they are the blockers the audit listed:

- Instances of an asset **share the template's buffers** -- `SkeletonUtils.clone`
  copies the nodes, not the geometry -- so every group is one geometry repeated at
  many transforms rather than a pile of different meshes.
- Grouping on the **resolved accent** rather than the variant id means one shared
  material per batch instead of `applyMaterialVariant`'s clone per instance, and
  `vault` and `mantle`, which resolve to the same colour, share a batch. 18 batches,
  not 21.
- **Gate-bound visuals are simply left unbatched.** `setVisibleAt` has no meaning for
  a group, and `defaultLevel` binds none, so the correct thing is to keep them whole
  rather than to write a path nothing exercises.

The grouping is pure and extracted to `src/render/presentation/visualBatching.ts`
with 10 tests, the way `ResolutionController` was.

Two caveats, stated because they are real:

1. The collapse needs `WEBGL_multi_draw`. Chromium has it and the pinned Playwright
   Firefox does not; there, three falls back to a draw per *visible* instance, which
   is the count from before batching with the culling still applied. The win is
   browser-dependent; the fallback is not a regression.
2. It is not pixel-free. Against the committed baselines at a tightened
   `maxDiffPixelRatio` of 0.00001: White Line high and low are **pixel-identical**,
   and the hunters shot differs by **111 px of 921,600** (0.012%), scattered along two
   silhouette edges -- a batched transform arrives through a texture instead of a
   uniform, and sub-pixel coverage moves with it. The finish view, captured before and
   after, differs by **0 pixels** at a threshold of 2 with a maximum channel delta of 1.

### A third hostile that is not a third set of numbers

The **bulwark** walks a plate at the player. Inside a 137-degree frontal arc it scales
incoming damage to **0.18**; it brings that arc round at **1.5 rad/s**, about a second
for a quarter turn; and it can only commit a shot inside a 57-degree firing cone, so
flanking takes its damage away as well as its armour. Sized so the contrast is
teachable rather than a slog: a full 30-round carbine magazine into the plate is 184
damage against 200 health and does **not** kill it, while six rounds into its flank do.

The counter is the movement kit, which is the point. `turnRate` is what keeps the
shield a window rather than a wall.

It is drawn with the brawler's GLB -- only two hunter models are authored, and
regenerating the art pipeline for a third silhouette is the trap in section 11 -- and
marked out by a dark plate with a glowing edge in the palette's hot yellow, carried on
the model's forward axis so the arc the simulation protects is the arc the player can
see. Turned side-on it is a bright sliver and the body is wide open, which is exactly
the read the mechanic needs. The plate falls and fades with the body rather than
hanging in the air, and the presenter now damps yaw along the **shortest** arc: the
old linear damp spun a figure the long way round whenever the simulation's yaw crossed
the wrap at +/-pi, which a bulwark turning slowly through a half circle reaches on
purpose.

A deflected hit says so. The hit event carries `deflected`, the damage number and the
hitmarker go small and grey, and the mix plays a flat clank instead of the confirm
blip -- the cue is to stop shooting the plate.

The three arenas now ask different questions instead of holding two bots each:

| arena | before | after |
| --- | --- | --- |
| Atrium | ranged + brawler | unchanged -- it teaches the pair |
| Gallery | ranged + brawler | **bulwark head-on, a marksman on each flank** |
| Roofline | ranged + brawler | **bulwark and brawler in front, marksman and brawler behind** |

Nine hostiles instead of six, so `parSeconds` moved 150 -> 185.

`SpawnDefinition['kind']`, the level schema, the V1 migration, the editor's spawn
palette and its viewport marker, `CharacterPresenter`'s profile map and the palette's
hostile accents all took the third value; 7 simulation tests cover the arc, the turn
rate, the firing gate and the published maximum, and 2 schema tests cover the new
spawn kind through validation and migration.

### The health bar was reading against a number the simulation had already scaled

`updateHealthDisplay` divided by a hardcoded `120` for a brawler and `100` for
everything else. A daily contract scales bot health -- today's `Glass` multiplies it
by 0.8 -- so on a Glass day an **undamaged** hostile showed a bar 80 per cent full,
and a bulwark at 200 health would have shown one that never left the top of its range.
`EntitySnapshot` now publishes `maxHealth` and the bar measures against that.

That is the whole of the visual-baseline change: regenerating the hunters shot moved
**18,330 px (2.0%)**, and the diff image is two health bars and nothing else. The
baseline had been capturing a bug whose severity depended on the calendar. The
regenerated one reproduces pixel-exactly on a fresh run.


---

## 13. A Persona-style pass over the interface

Verified: `npm test` **317 passed / 30 files**, `npm run typecheck` clean,
`npm run build` clean, `FLOWSTATE_STATIC_DIST=1 npm run test:e2e` **41 passed**
(Chromium + Firefox), `npm run art:validate` clean at 1.93 MiB of 25.00 MiB, and the
3 Chromium visual baselines pass **unregenerated** -- which is the correct result for
a pure interface pass, per the trap in section 12: the baselines hide everything
except the canvas, so UI work that moved them would mean something was wrong.

Nothing in `src/simulation/` was touched. One field was added to `RuntimeUpdate` and
one event kind was read in `GameRuntime`; the rest is `src/ui/`, `src/game/`,
`src/audio/` and the stylesheet.

### The whole e2e suite has always run with reduced motion on

Worth knowing before anyone reads the flake risk in this pass as low by luck.
Headless Chromium reports `prefers-reduced-motion: reduce`, and `saveDefaults()`
seeds the save's `reducedMotion` from exactly that query. So all 35 pre-existing e2e
tests run with every animation in this pass switched off, which is why none of them
needed changing. The two new tests that actually exercise the transition call
`page.emulateMedia({ reducedMotion: 'no-preference' })` first.

### The results screen is a sequence

`CompletionState` computed a letter rank, signed deltas, record flags and per-split
deltas already and rendered them as a static grid. It now staggers them in on a shear
off a `--step` custom property, counts the headline numbers up, slams the rank in at
3.6x and settles it, and stamps the record flag. Timings live in `presentation` in
`content/config.ts` and are handed to CSS as custom properties rather than written
twice. `useRevealSequence` reports only *when the sequence is over*, because that is
the only thing React needs to know: the motion is CSS, and the numbers have to land
on their real values rather than an eased approximation.

The action button is deliberately not animated. Playwright treats an element whose
box is still moving as unstable and waits on it, and this is the button every
completion test presses. The rows above it hold their layout from the first frame,
so it never shifts.

**A real bug the environment surfaced.** The preview pane reports
`visibilityState: 'hidden'` permanently, which starves `requestAnimationFrame`. The
results screen froze on its first frame -- every line at zero opacity, every number
at zero -- which is exactly what a player who alt-tabbed mid-results would have got.
Both the sequence and the wipe now carry a `setTimeout` floor that only ever
*settles* them; the frame loop is still what drives the motion.

### A wipe between screens

`menu`, `game`, `builder` and `editor` swapped with no transition. A sheared band
with a three-colour leading blade now carries the wordmark across the frame while
the new screen mounts behind it. `go()` in `App.tsx` sets the mode and raises the
wipe in the same commit, so `GameScreen`'s WebGL and Rapier mount is neither delayed
nor doubled, and the layer is `pointer-events: none` for its whole life.

Two things are worth recording:

- **React's `onAnimationEnd` does not fire for a dispatched `animationend` under
  jsdom**, which would have left the removal path untested. The component uses a
  native listener instead; it behaves identically in a browser.
- **Playwright cannot observe the wipe from outside the page.** Mounting the next
  screen blocks the main thread long enough that the first external poll runs after
  the band has already gone -- `toHaveCSS` reported "element(s) not found" for a full
  five seconds against an element that had certainly existed. The e2e test installs a
  `MutationObserver` inside the page instead, which also lets it assert
  `pointer-events` for every frame the band was mounted.

### Menu and overlay chrome, and a fit bug that depended on the calendar

One shear angle for the whole interface, declared once as `--cut`. Sheared blocks
counter-shear their own children, so the block is off-axis and the words on it are
not. **Buttons and the control chips take the tilt as a `clip-path` parallelogram
rather than a transform**, because their labels are bare text nodes with nothing to
counter-shear -- skewing them came out italic. A dot screen grades across the menu's
yellow slab and the two cards, the record card now runs off the right edge of the
frame, and hovering a menu row shuffles it 11 px out of line with a blade on its
leading edge rather than only tinting it.

The standby card carried a real bug, and it was on `main` before this pass:

| at 1280x720 | before | after |
| --- | --- | --- |
| `.start-card` overflow | **45 px** | **0 px** |
| `Enter run` | clipped to a 10 px sliver of a 34 px button | fully visible, bottom at 639 of a 659 px content box |
| headroom before it clips again | 0 | **69 px** |

Section 12 measured 25 px of overflow with the button visible. It is 45 px today
because **the day's contract sets the tallest block on that card and its copy is not
fixed-length** -- today's `Glass Cannon` wraps to two lines. This is the same class of
bug as the health bar in section 12: correct on the day it was measured, wrong on
another day.

The fix is not a shave. `overlay-state` is a flex column with its own `gap`, so every
block margin inside it was doubled spacing -- 110 px of it, measured. Dropping the
redundant margins under the short-viewport rule reclaims more than the contract can
plausibly consume, and an e2e test now asserts the overflow is zero, the button sits
inside the content box, and there is at least 30 px of slack left.

Every geometric move on this card is height-neutral by construction: shear, clip and
a tone layer are transforms and paint, and none of them occupy a pixel of layout.

### Kill and chain feedback, and the part of it that was wrong

The kill treatment adds **no DOM at all**. It restyles the hitmarker and damage
number that were already inside the reticle budget -- the marker becomes a repeating
conic spoke burst, hollow at the centre so the two confirm strokes still read. A unit
test asserts the HUD's direct-child count is identical with and without a kill.

The chain flourish is new, and the first version of it was a mistake worth recording.
It was the series' signature: spokes radiating from the centre across the whole
frame, hollowed out for 170 px so the reticle stayed clear. Measured against a
control frame with the canvas hidden, it changed **228,983 pixels -- a quarter of the
frame** -- with **0 inside the 93 px reticle budget** and the nearest changed pixel at
204 px. So it passed the rule as written and was still wrong: it fired in the same
yellow the grapple anchors and wall-run trim are drawn in, while the player was
airborne, and the periphery is where a movement shooter reads the geometry it is
about to land on. Clearing the crosshair is not sufficient.

What shipped is corner-anchored -- spokes exist only past 330 px from centre, so at
720p everything around the horizon line is untouched -- and the count sits on a solid
ink plate, because hollow type over the city was unreadable.

| | changed px | inside 93 px | nearest changed px |
| --- | --- | --- | --- |
| first version | 228,983 | 0 | 204 |
| shipped | **100,423** | **0** | **333** |

`chainEarnsFlourish` is extracted as a pure predicate in `content/config.ts` rather
than left inline in `GameRuntime`, because that class needs WebGL and Rapier to
construct and cannot be reached from a unit test -- and how often a full-frame effect
fires at an airborne player is the one part of this worth testing directly. Four
tests cover it, including that it can fire at most 4 times across the longest chain
the scoring allows, and that it is reachable inside a run that earns an S.

Under `reducedMotion` the flourish is not softened, it is **not drawn**. The chain
multiplier in the reticle cluster already reports the same fact without moving.

### Interface audio

`AudioManager` gained a `cue()` method with five voices built from the same two synth
primitives as the rest of the bus. `src/audio/interfaceAudio.ts` owns a second
`AudioManager` instance for the interface, because `GameRuntime` disposes its own --
and disposing it closes the `AudioContext`, which would silence the menu at exactly
the moment the player returns to it. Cues are delegated from the document rather than
threaded through `MainMenu`, `GameOverlay`, `WeaponBuilder` and the editor's
toolbars, and the tone is read off the classes the stylesheet already uses, so a
button that looks like the primary action sounds like one.

Kept audibly apart from the combat mix on purpose, since section 5 records what it
cost when taking damage played the hit-confirm sound: hover is 0.014 gain against the
hit-confirm blip's 0.055, and every interface voice is square or triangle, leaving
the sine pairs to `checkpoint`, `split` and `complete`. The results stinger is
delayed 0.58 s so it clears `complete`'s 0.54 s tail -- and its percussive layer is a
low tone rather than a noise burst, because `crack` takes no delay and would have
fired at zero, straight over the cue the offset exists to avoid.

jsdom has no Web Audio at all, so the cues are tested against a recorder that
implements exactly the surface `AudioManager` uses; without it these would have been
typechecked and never heard by anything. Verified in a real browser as well: **zero
oscillators before the first gesture** -- the context cannot legally start earlier --
and the expected 880 Hz square on the first press followed by 1520 Hz triangles on
hover.

### Not done

The gun bench got the shared primitives and the display type but no bespoke pass; it
is still a grid-aligned panel on a flat field. No webfonts were added, so the display
tiers remain `Impact, 'Arial Narrow'` -- a closer face means a build change, a FOUT
story and new visual baselines, and that is a decision to take deliberately rather
than smuggle into a CSS pass.
