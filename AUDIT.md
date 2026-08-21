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


---

## 14. The world: buildings, floors and the sky

Verified: `npm test` **328 passed / 31 files**, `npm run typecheck` clean,
`npm run build` clean, `FLOWSTATE_STATIC_DIST=1 npm run test:e2e` **41 passed**,
`npm run art:validate` clean at 1.93 MiB of 25.00 MiB, and the 3 Chromium visual
baselines **regenerated** -- numbers below.

None of this touched `tools/art/generate_vertical_slice.py`, so `npm run art:build`
was not needed and no GLB changed. The skyline, the sky and the deck markings are all
runtime TypeScript in `WorldPresenter`.

### Every building was the same building

`buildCity` instanced one `RoundedBoxGeometry(1, 1, 1)` 180 times and varied only the
`scale`, so height and width were the entire vocabulary of a 180-tower skyline. Worse,
panes were placed on a single inward-facing wall -- the other three faces of every
tower were bare, including the one pointing back up the route, which is the face a
player running the route sees most.

`src/render/presentation/citySkyline.ts` now owns two pure decisions, tested without a
WebGL context the way `ResolutionController` and `visualBatching` are:

- **Six masses**, each a stack of blocks in normalised space: a slab with a roof
  housing, a double setback, an overhanging crown, a podium and shaft, twinned shafts
  of different heights, and a ziggurat. Each merges into one geometry, so the cost is
  one draw call per archetype rather than per building. The near tier is weighted
  toward the solid masses, because a wall of twinned shafts stopped closing the
  corridor in -- that tier's job.
- **Four facade patterns** -- grid, ribbon, vertical stack, sparse -- and the same
  block list tells the pane placer where the wall actually *is* at a given height, so
  windows step in with a setback instead of hanging off the side of it. Both visible
  faces are lit now.

Towers also carry a small yaw and one of six building tones. The tone matters more
than it sounds: every tower was `#0a0f16`, which is very nearly the sky at zenith, so
with two faces lit the windows read as lights floating in the dark with no mass behind
them. That was visible in the first capture and is why the tones exist.

Measured at the spawn view, high quality, dynamic resolution pinned off, back to back
on the same machine:

| | draw calls | triangles | frame |
| --- | --- | --- | --- |
| before | 155 | 186,859 | 3.7-3.9 ms |
| after | **165** | **144,555** | 3.7-4.4 ms |

Ten more draw calls and **42,304 fewer triangles**, because the archetype blocks are
plain boxes: rounding four or five of them per tower would have multiplied the
skyline's triangle count for a bevel that is sub-pixel at these distances. Frame time
is inside the noise -- an earlier pair of readings at 1.2 ms on a quieter machine
turned out to say more about machine state than about this change, which is why the
comparison above was re-run back to back.

### The floors were bare, and the reason is worth writing down

Every walkable surface is one 4x4 m `rooftop-platform.glb` scaled up -- a 30x22 m
arena floor is that asset stretched 7.5 times in X and 5.5 in Z -- and
`MaterialLibrary.loadSurfaceTextures` sets `RepeatWrapping` but never sets
`texture.repeat`, while the Blender pipeline UV-unwraps each face 0..1. So the 1024²
surface sheet is stretched by the same factor the deck is: whatever detail it has is
smeared to invisibility on a big deck and crisp on a small barrier.

`buildDeckMarkings` lays two overlays over every walkable top face, and the thing that
makes them work is that **their UVs are computed in world metres at build time**
rather than inherited from the mesh they sit on. A panel seam is 2 m apart on the
start floor and 2 m apart on the final arena whatever those decks are scaled by. Both
are one merged geometry, so the whole route's floor decoration costs two draw calls:
panel seams with bolt heads, and a yellow hazard band inset from every deck edge,
which also tells the player where the drop is.

A grime layer was tried and removed. Hard blots read as stains and tiled visibly every
four metres; softening them to radial gradients at the strength this wants made an
eight-bit alpha ramp quantise into contour rings, which was worse than the bare deck.

### The sky

The upper third of the frame was empty except for gantries, which is where the player
is looking through most of a grapple. Four instanced draw calls fill it:

- **Airships.** A merged hull -- ellipsoid, tail cross, gondola -- with an advertising
  banner down each flank and a third across the belly, drifting on wrapped lanes.
- **Air traffic.** Light streaks on stacked lanes, red going away and cool white
  coming toward. Two thirds run *along* the route above it rather than across it,
  because those are the ones in frame while the player is moving down it.

The counts and the lane lengths are one decision, not two. This is a corridor between
tower walls, so the visible sky is a slot: the first version spread seven ships and
thirty cars evenly over a few hundred metres and **nothing was ever inside it**. The
lanes are short and the traffic dense so something is crossing most of the time.

Banners, lamps and cars are unlit `MeshBasicMaterial` rather than emissive standard
material, and that is not a shortcut. A standard material's emissive term is not
multiplied by the instance colour, so the per-ship and per-car tints were drowned by
the material's own glow and every banner and every streak came out the same white.
Measured in frame, twice.

**Searchlights were tried and cut.** A flat-filled cone is invisible at an opacity low
enough to pass for light and reads as a grey concrete wedge at any opacity where it is
visible; an alpha ramp along its length improved it and did not fix it. Two attempts,
both looked at in frame, neither produced something that looked like light rather than
like a mistake -- so it is gone rather than left in looking like a fix.

### The baselines

All three moved, legitimately and enormously, and were regenerated:

| baseline | pixels changed | of frame |
| --- | --- | --- |
| White Line high | 452,670 | **49.1%** |
| Corporate hunters high | 458,331 | **49.7%** |
| White Line low | 216,237 | **23.5%** |

The sky moves, so the obvious risk was a non-deterministic baseline. It is not one:
`GameRenderer` pins `time` to a constant and `frameSeconds` to zero under
`visualRegression`, and every sky position is a pure function of `time` rather than
integrated per frame. Verified rather than assumed -- the regenerated baselines pass
at a temporarily tightened `maxDiffPixelRatio` of **0.00001**, about nine pixels of
921,600, on a fresh run. The threshold is back at 0.035.

One operational note: regenerating these needs `--timeout=150000`. At the default 30 s
two of the three time out during the update pass, then pass on a normal run.

### Also removed

The menu's route-brief strip -- `03 ARENAS / 09 HOSTILES / 172 METRE ROUTE` -- at the
user's request, along with `routeBrief()` and the 13 now-dead `.protocol-strip` rules
in the stylesheet.

---

## 15. The pivot to first-person character action

Ten commits, `562e7fc..f35050b`. The brief was the handoff in `PROMPT.md` at the time:
make melee the core verb, turn the chain into a style meter, and treat the arenas as
rooms to fight out of. Eight items; seven landed, one was measured and thrown away.

Verified at the end: `npm test` **427 passing / 37 files**, `npm run typecheck` clean,
`npm run build` clean, `npm run art:validate` clean at 1.93 MiB of 25.00 MiB, and the 3
Chromium visual baselines passing. **`npm run test:e2e` is not green on the machine this
was done on** -- see the last subsection, which is the most important thing in this
section for whoever reads it next.

### The control scheme moved

`Action.Slash` (new, `1 << 17`) is the blade on the left mouse button, read from `held`
rather than `pressed` so holding it produces a rhythm at the recovery rate. `Action.Fire`
kept its name and became the sidearm on the right button. `Action.Melee` on `E` is the
heavy. Aiming came off the mouse entirely and onto `V`: three attack-adjacent verbs, two
mouse buttons, and the one a player uses least is the deliberate stand-still zoom.

`meleeDamage` and `meleeRange` left `WeaponDefinition` -- they were the same two numbers
repeated on all four chassis. Melee tuning briefly lived in `content/config.ts` as `melee`
and then moved again into `content/blades.ts`, which is where it is now.

### The blade, and the number that mattered was not the blade's

The light reaches 3.6 m through a 130-degree cone, recovers in 0.24 s and kills a
hundred-health hunter in two. Measured, the usable envelope is 3.5 m of *ground* distance,
of which 0.7 m is the two capsule radii. Generous on purpose: judging reach in first person
with no visible arm is the risk the whole pivot turns on.

The finding was elsewhere. Standing still with the blade held while a brawler closed from
14 m landed **zero of twenty-two swings and killed the player** -- its `preferredRange` was
5 m, correct for a game whose primary verb was a rifle and fatal for one whose primary verb
reaches 3.6. At 2.4 m the same exchange is two swings, 2.00 s and fourteen damage taken.
Two cases now hold the two numbers together in both directions.

The heavy on `E` is not a bigger number: it sweeps every hostile in a 160-degree arc where
the light takes the nearest, a plate scales it to 0.5 instead of 0.18, and it costs 0.46 s
of recovery -- longer than a brawler's whole wind-up.

### The chain does the work it was always able to do

`ComboLinkKind` gained `slash`, `heavy` and `dodge`. The no-repeat rule then needed no
changes: measured, several lights connecting inside one chain pay **exactly one** link, and
following one with a heavy pays a second.

One consequence worth knowing: with ten distinct link kinds, an eight-link peak -- the
S-rank gate -- is reachable inside a single fight without touching the movement kit. The
rank curve is measurably easier than it was and has not been retuned.

### Hitstop is a stopped clock, not a stopped step

The simulation keeps stepping at 60 Hz. What stops is the presentation clock: `frameSeconds`
goes to zero and `time`, which every animation and effect birthday is a function of, is
accumulated from it rather than read off `performance.now()`. In first person the largest
thing on screen is the viewmodel, so a swing stopping dead mid-arc is most of the read.

Only the blade and kills freeze, which is a design statement and also arithmetic: an SMG at
1020 rounds a minute lands one every 3.5 frames, and a three-frame freeze per round is not
hitstop. A 0.1 s refractory gap stops a crowd doing the same thing.

**Known limit, stated because it is real:** entity positions still come from the live
snapshot, so a brawler at 6.2 m/s slides 0.31-0.62 m during a freeze with its limbs stopped.
Holding the snapshot instead trades the slide for a catch-up pop of the same distance in one
frame, which reads worse.

### The dash became a defence

A dash arms 0.22 s of invulnerability -- longer than the 0.16 s dash, because judging a
dash-length window off an audio cue is a coin flip. A telegraphed shot that resolves inside
them is a perfect dodge: no damage, and a chain link.

The check sits where the trace resolves, not at the moment of the dash. A dodge has to mean
a round that *was going to land* did not; keyed off the dash it would pay for dashing at
nothing. And the frames are gated while the dash is not: a ground dash has no cooldown, so
invulnerability tied to it would be permanent on a flat floor. Measured against a dash
spammed every tick, dashes outnumber defended dashes by more than half again and uptime
caps at 29 per cent.

### The route was never walkable, and nothing noticed

Both ramps on the shipped route had a hand-set `rotationX` with the sign inverted, so
`rise-a` sloped *down* away from the start floor and left an eight-metre hole between the
two decks it was supposed to join. Holding forward from the spawn fell through it and died
on tick 263 -- identically on `562e7fc`, so it had never been walkable. Nothing caught it
because nothing walked it: the completion e2e enters through `?scene=finish`.

`rampBetween` now derives the transform from the two decks it joins.
`tests/routeTraversal.test.ts` holds both the geometry and the walk. **Combat became
reachable in a browser for the first time**, which is what unblocked every later item's
verification.

### Crowds, waves, and the arenas becoming rooms

Twenty-eight hostiles across seven waves where the route held nine in three static groups.
`wave` on a spawn activates wave *n+1* on the tick the last of wave *n* dies; an unarrived
wave costs nothing and cannot open a room early, because a hostile that has not spawned is
still alive as far as the completion check is concerned. Peak concurrent is eight, in the
Roofline.

Balance moved with the counts: marksman damage 10 -> 8, brawler 14 -> 11, and the player's
pool 100 -> 140, out of the simulation and into the tuning.

And the arenas were not rooms. A room activates at 28 m from its checkpoint and a brawler
wants to be 2.4 m from the player, so the Atrium's first wave walked the full forty metres
back down the bridge and fought on the *start floor* with the arena empty behind it.
`botLeashMetres` leashes pursuit to 22 m from a hostile's own spawn. Only pursuit is
leashed, so a marksman's 27 m firing gate still reaches a player at the threshold.

`?scene=crowd` stages the biggest authored wave with no gating, which is how the worst
frame the content can produce is measurable in one browser step:

| | draw calls | triangles | frame | render scale |
| --- | --- | --- | --- | --- |
| spawn view, nothing active | 167 | 144,655 | 2.06 ms (3.2 worst) | 88% |
| eight hostiles, all firing | **307** | 130,401 | **4.17 ms** (5.0 worst) | 84% |

About seventeen draw calls a character. Characters are the one thing on the route that is
not batched, so that is the number to watch if the ceiling goes past eight.

`?scene=hunters` had to be rebuilt while in there: it repositioned spawns *by id*, and the
ids it named stopped existing when the arenas were re-authored, so the character pixel
baseline had quietly stopped staging the pair it is named after.

### The launcher was built, measured, and thrown away

Item 6 of that brief. A launcher on crouch-plus-heavy, bot air state, and a swept lift
speed. Nothing shipped.

| lift | apex | airtime | hits landed in the air |
| --- | --- | --- | --- |
| 4 m/s | +0.25 m | 0.25 s | 0 of 1 |
| 7 m/s | +0.82 m | 0.47 s | 1 of 1 |
| 12 m/s | +2.47 m | 0.65 s | 1 of 1 |

The launcher's own 0.40 s recovery is as long as the airtime it buys, so one follow-up
fits. That is fixable with a float, and the fix makes the real problem worse: **the generous
reach that makes first-person melee work makes vertical displacement meaningless.** At every
lift including +2.47 m the *grounded* player still hit the target, because 3.6 m of
spherical reach covers an enemy two and a half metres up. Forcing the player upward means
shortening the reach, which is the thing that stops the depth problem coming back. So "air
combat" here is standing still and looking up, which is the opposite of a game whose
differentiator is the movement kit. Launching a crowd confirmed it: six caught by one swing,
five floating in a cone in front of a stationary player.

Incidental: bot airtime plateaus at 0.65 s between 9 and 12 m/s of lift where the arithmetic
says 0.86 s. `enableSnapToGround(0.3)` on the bot controller fights upward motion.

### The blade is generated, not exported

`tools/art/generate_vertical_slice.py` was left alone. Trap 9 records the characters
shipping visibly broken from running `art:build`, and section 14 set the other precedent:
the skyline, the sky and every deck marking are runtime TypeScript. A blade is simpler
geometry than any of those and its swing is timed off numbers an authored clip cannot know.
`art:validate` is unchanged at 1.93 MiB as a result. Blender 4.5.10 is bundled at
`.tooling/blender-4.5.10` if that ever needs revisiting.

Three things were wrong in the first version and all three only showed on screen. Roll was
doing the work, which spins a blade about its own length -- the silhouette barely moves and
it reads as a twitch; yaw and pitch carry the cut now, and the two swings travel in opposite
directions so alternating them reads as a combination. A negative X rotation pitches the tip
*down*, and the blade lay across the deck pointing at the player's feet. And the lit edge was
on the underside, where the view camera never sees it.

The blade and the sidearm share one pair of hands: the blade is what is held, the gun comes
up when fired or reloading, holds 0.95 s so a burst does not flicker, and drops away. The
gun bench calls `showBlade(false)`, because the bench is about the gun.

### The mix was rebuilt twice

The first pass added a duck, a generated convolution reverb with three send levels, a
limiter and deterministic per-event pitch variation. The user's verdict on it was that it
still sounded like an arcade machine, and they were right: every cue was one or two square
and sawtooth layers with fundamentals between 300 and 1500 Hz and nothing under any of them.
A 640 Hz square is a beep at any volume.

The second pass rebuilt the palette from three layers: **`sub`** (a sine falling or rising
through the bottom two octaves, *saturated* and then rolled off, because a pure 40 Hz sine
is inaudible on a laptop and its harmonics are not), **`boom`** (lowpassed noise -- weight
with no pitch), and **`tick`** (four to eight milliseconds of band-limited noise, the only
thing left above 1 kHz, capped at 0.045 gain). Every run cue dropped an octave and a half to
two octaves. The hit confirm is an 84 Hz thud where it was a 640 Hz square; the kill is two
subs an octave apart where it was an 880/1320 chime; the chain climbs from 68 Hz rather than
520, so a long chain gets heavier instead of shriller. Three cases guard the register
directly.

The interface swapped sides with the run: the run lives under 200 Hz, so acknowledgements
sit *above* it at 220-420 Hz, still square and triangle so they can never blur into the
sine layer the run is built from.

Then the bed, which was the piece that had been missing. Every cue was a transient, so the
low end existed only in bursts and the duck had nothing sounding to take away -- the
*return*, which is the effect, had nothing to return from. Two layers: a floor (a fifth,
34 under 51 Hz, louder in a live room than in a corridor) and a movement layer (looped
noise whose level and cutoff open with player speed, which is the audible half of a cue the
renderer has had since section 3.3). Both route *into* the bus so a duck takes them with it.
Driven by a new `sustain` method rather than by `consume`, because the menu shares this class
and never calls it.

### Two bugs the verification found, unrelated to any item

`GameRenderer.dispose` never released the WebGL context. `renderer.dispose()` frees three's
own objects and leaves the context alive; a browser caps how many exist at once -- Chromium
at sixteen -- and kills the oldest to make room, so a session that enters and leaves a run
enough times has the renderer taken out from under a run still using it.
`forceContextLoss()` is the only way to hand it back.

And the debug channel gained `position`, `dodge` and `hitstop` lines. Position because
authoring or driving a route without it means guessing from the view, and a run that falls
off the level looks exactly like one that stopped against a lip -- which is how the ramp bug
stayed hidden.

### The e2e suite, and the thing to fix first

**`npm run test:e2e` was not green at the end of this work and I could not make it so.**
The state, stated as precisely as it can be:

- Every failing case passes **in isolation** -- entering a run with and without the debug
  channel, both blades, the audio graph in both browsers, the perfect dodge, and the four
  content-sensitive cases together.
- The failures concentrate in the cases that build a renderer and drive combat, they move
  around between runs, and they arrive with load averages between seven and sixteen on a box
  where the suite used to finish in eight minutes and took twenty at the end.
- Bringing the runtime up -- WebGL renderer, Rapier world, navmesh, character and viewmodel
  GLBs -- measures **7.7 to 8.9 seconds**, and it measures the same on `562e7fc`. So it is
  the cost of starting, not a regression. Against eight seconds, the fifteen- and
  twenty-second budgets scattered through `app.spec.ts` were never a margin, and the
  five-second default on `toBeHidden` after clicking into a run was less than that again.
  They are now three named constants with the measurement written next to them.
- Two genuine assertion failures did come out of it and are fixed: one named the health pool
  as the literal `100`, one named the save schema version as `4`.

That reads as the machine rather than the code, and the startup measurement is the strongest
evidence for it. It is not proof. **Run the suite somewhere quiet before trusting anything
from `af5f9d7` onward.**

### Also worth knowing

- AUDIT trap 6 is **stale**. Headless Chromium reported `prefers-reduced-motion: reduce`
  when section 13 was written; on this Playwright build both Chromium and Firefox report
  `no-preference`. Tests that care now emulate the media explicitly at both ends.
- `FLOWSTATE_STATIC_DIST=1` serves `dist/` through Playwright's own route interception, so
  no server is needed -- but `npm run build` has to come first or you are testing the
  previous commit.
- The save is at **V5**. It added `blade`; V1-V4 saves inherit the reference style.
- **There is no volume control anywhere in the game.** That was theoretical while every
  sound was a transient. With a continuous bed it is a real gap.

## 16. An interactive mix, an honest corner, and life from damage

Five commits, `f35050b..0c6dffc`. The brief was `PROMPT.md`: make the mix react and
combine, fix the HUD corner that claimed `CARBINE` over a blade, keep the gun bench
working, and pay the player for aggression. Four jobs, all four landed, plus the volume
control the handoff listed as trap 11 and suggested doing first -- which was the right
order, because everything else in job 1 makes the mix louder and busier.

Verified at the end: `npm test` **471 passing / 38 files**, `npm run typecheck` clean,
`npm run build` clean, `npm run art:validate` clean at 1.93 MiB of 25.00 MiB, and the 3
Chromium visual baselines passing **untouched** -- which is the expected result and worth
stating, because trap 7 says pure UI and pure audio cannot move them and this pass is
both.

### The volume control, first because the bed made it real

A save field (`SaveSettingsV3`, schema **V6**), a row at the top of the settings grid, and
one gain node. Zero reads as `MUTE` rather than as `0%`.

The node's position is the only interesting decision. The duck writes *absolute* values to
the bus gain -- down, hold, back to `BUS_LEVEL` -- so a volume applied there would be
overwritten by the next kill, or would have to be folded into every ramp the duck
schedules. The master sits one node further down, and ahead of the limiter so a quiet mix
is a *less compressed* one rather than the same compression turned down. A case holds it:
after `setVolume`, a kill's duck still returns to exactly the level it left.

The interface keeps its own `AudioManager` -- it outlives every run by design -- so it is
told the level separately, on mount and on every settings change. `migrateSaveData` clamps
what it reads, because a hand-edited save with a volume of 40 would hand the bus a gain of
40 and the limiter downstream is glue, not protection.

### Job 1, and the change that mattered was the key

Every pitch in `AudioManager` was an arbitrary number that sounded right on its own, which
is exactly why two cues landing together sounded like two cues landing together: a kill at
104 Hz over a chain tone at 68 is a minor sixth *and a bit*, and the bit is what the ear
hears. There is now a root -- **34 Hz, the bed's own floor**, because the floor is the only
thing always sounding and therefore the only honest place for a tonic -- and every tonal
layer in the game is a just interval over it. Just rather than tempered: at this register
the player hears the harmonics the drive stage generates rather than the fundamentals, and
small integer ratios stack those series instead of beating them two cents apart.

One rule inside the table, and it is the design: **the flat second is reserved for things
that happen *to* the player.** The telegraph, damage taken, a wave arriving, a chain
breaking. Everything the player does is consonant -- the hit confirm on the minor third,
the kill on the fifth the bed is built from, the dodge travelling two octaves from fifth to
fifth. The mix now says which direction a transaction went before it says anything else
about it.

The per-event variation had to be split to make that true. At 5.5 per cent a detune is 93
cents, which is wider than the smallest interval in the table -- so a "varied" root was
sometimes an audibly flat second. Tonal layers get 2 per cent; noise keeps 5.5, having no
pitch to be wrong about.

**The chain drives the mix.** It is the style meter and the mix said one thing about it: a
tone per link. Now the floor climbs a scale degree every three links, a colour note opens
over it, both reverb sends rise and the movement layer brightens -- all of it saturating at
eight links, which is the S-rank gate. None of it is a new cue. They are targets on nodes
that already exist, followed over `BED.followSeconds`, because the lesson behind
`comboScoring.flourishFromLink` is worse in sound than in pixels: a player can look away
from a flourish. A case drives thirty frames of a twelve-link chain and insists nothing
fires. The per-link tone climbs the scale rather than multiplying 68 Hz, and plateaus at
two octaves -- a long chain gets heavier before it gets higher.

The chain's *window* drives the colour note too: it fades through the last third of the
window -- the same 0.34 the HUD's combo readout calls `lapsing`, so the mix and the frame
cannot disagree about when a chain is in trouble. The floor it climbed to does not fade
with it, because losing the chain is what takes that away and the drop is what should land.

**A cue knows what it hit.** `EntitySnapshot.profile` has carried the material since the
characters were authored and the mix read none of it. A plate rings, at 820 Hz where a
narrow band is metal rather than the beep the register pass removed; a brawler at arm's
length is the densest impact in the game; a hunter is the reference. `GameRuntime` fills a
reused `Map` per frame rather than allocating one.

**And the cues combine.** One target produces one impact cue per batch, worked out from the
whole batch before anything plays. A killing slash arrives as a `melee`, a `hit` and a
`kill` on the same tick, and playing all three is three impacts for one attack. Now the
kill carries the blade's own edge and a longer sub, and the confirm stands down. A slash
the guard ate keeps the edge and the ring and loses the weight entirely.

The same argument caps kill cues at two a batch. A heavy sweeps a 160-degree arc, so three
bodies on one tick is ordinary play -- and three copies of one cue at one pitch is not a
bigger sound, it is the same waveform nine decibels louder. The first is the full cue, the
second answers it a fourth up, shorter and quieter, and the third is not played.

**The three blades sound like themselves.** Tempo on the root, Cleave lower, longer and
darker on the flat seventh, Riposte higher, shorter and brighter on the minor third -- the
same three differences `content/blades.ts` already states, in the only three terms a
synthesised impact has. Every style stays inside the register and inside the key, guarded
the same way the reach is.

**I cannot hear any of this, and said so at the time.** What is guarded is structural: that
every pitch in the run *and the interface* is a degree of the key (with a negative control,
because a tolerance wide enough to allow the detune could otherwise pass anything), that the
chain opens the four things it claims to and fires nothing per frame, that a plate rings and
carries no weight, that a killing slash is one impact, and that each blade is
lower/longer/heavier or the reverse. What is verified is that the real graph runs: the e2e
that drives it through combat passes in Chromium (55.9 s) and Firefox (13.5 s) with an empty
console.

Constants worth turning, all at the top of `AudioManager.ts`: `KEY_HZ` transposes the whole
game; `CHAIN.floorLift`, `harmonicGain` and `sendLift` are how much a chain may change the
room; `TONAL_SPREAD` is how loose the tuning is; `BLADE_VOICE` is three rows of how each
blade lands; `MATERIAL` is three rows of what things are made of.

The test double grew with it, which is the only reason any of this is checkable: it now
records the player's own level separately from the bed, the two reverb sends separately
again, every pitch a *held* oscillator was moved to (the only observable form a
transposition can take, since an oscillator cannot be restarted), and how long each tonal
voice was scheduled for.

### Job 2: two timers in two layers is how a corner starts lying

The ammo corner rendered `activeWeapon.name` and a magazine count unconditionally, so it
read `CARBINE 30/120` while a blade was on screen and in the player's hands. The label was
the symptom: `ViewmodelPresenter` owned a private 0.95 s timer that chose which model to
draw and the HUD had no way to ask it. The decision is now `player.weapons.inHand` on the
snapshot, the hold is `gunHoldSeconds` in `content/weapons.ts` next to the gun it belongs
to, and both presentation layers read the field.

Two more instances of the same disagreement fell out of moving it. A swing now clears the
hold outright -- the blade is what does the swinging, and the old arrangement ran the
blade's swing pose on a *gun* for up to 0.95 s after a shot. And asking for a gun brings it
up: selecting slot 2 used to change the name in the corner while the blade stayed on
screen.

The corner says the blade's style with no magazine when the blade is up, and the gun with
its magazine when the gun is up. The magazine's `aria-label` announcing the capacity is
intact for the gun case -- accessibility work that has now survived three HUD passes. The
low and empty states no longer fire for a gun that is not in hand: an empty magazine in a
holster is not an emergency, and it was reddening the corner border and the root class.

Three e2e cases changed because what the HUD says changed. Two read the corner for a
magazine at rest; the armory case reads the pause card's weapon strip instead, which is
where a carried build's magazine belongs. The swap case now asserts the blade at rest and
then both guns by name *and* magazine, which is the pair that used to be able to disagree.

Screenshotted at 1280x720: `TEMPO / BLADE` with the blade on screen, `CARBINE 26/120` while
firing, `TEMPO / BLADE` again a frame into a slash.

### Job 3 was a constraint, and it holds

`Gun builder` is unchanged: four chassis, five slots, the 3D preview driven by the game's
own `ViewmodelPresenter`, the stat rows, and the blade section above them. The four bench
and loadout e2e cases pass.

### Job 4: life from damage, and the styles already said it

Kills return health at the chain multiplier, capped per kill, and there is **no
out-of-combat regeneration at all**. Two numbers in `content/config.ts`: `perKill` 6, a
fifteenth of the pool, because a kill has to be worth taking a hit for and not worth
trading four; `maxPerKill` 18, which is exactly what the reference blade's ×3.0 ceiling
buys, so the cap and the curve land on the same number instead of the cap quietly
overriding it. Riposte reaches ×4.0 and is capped: the defensive blade may not also be the
sustain blade.

**No per-style field, and that is the finding.** Cleave already pays two links a kill, so
its chain -- and therefore its healing -- grows twice as fast per body. Measured over five
brawlers, Cleave heals 12 a kill where Tempo heals 9. A number on each style would be
saying the same thing twice.

Measured headless, five brawlers on a stationary player who only mashes the light and never
dodges, which is the worst case a player can actually produce:

| | clear | damage taken | healed | ends on |
| --- | --- | --- | --- | --- |
| with lifesteal | 3.52 s | 132 | 39 | **47** / 140 |
| without | 3.52 s | 132 | 0 | **8** / 140 |

That is the shape the design wanted: about a third of what the crowd cost you, back, and
only while you keep killing. The Roofline's eight still kill that player either way --
lifesteal buys 1.28 s and one more body, not a room you can stand still in.

Measured in a browser at `?scene=crowd`: a heavy that finished three hostiles at ×1.5 paid
a merged **+22** in one mark; singles read +8 and +14.

A `heal` event carries the amount rather than leaving presentation to infer it from the
health number moving. The mix answers with a rising fifth -- the consonance the bed is built
from -- where damage taken is a falling flat second, at the quietest level anything earned
gets, and with no duck of its own because the kill that caused it already ducked on that
tick. The HUD puts the number inside the health corner, merged over 420 ms so a heavy reads
as one climbing figure. No seventh readout.

**One thing I could not do: photograph it.** The mark lives 760 ms and capturing a frame of
this page takes about as long, so every screenshot landed after it had gone -- including a
parallel capture-then-read. It is verified by reading the live DOM mid-fight and by two
rendering cases.

### Also worth knowing

- The save is at **V6**. It added `settings.volume`; every earlier save inherits the
  default, and the value is clamped to 0..1 on read.
- `app.spec.ts` asserted schema version `4` in one place and `5` in another -- the last bump
  left one behind, which is a failure that reads exactly like a broken migration. Both now
  derive it from `migrateSaveData`.
- Trap 11 is **done**. There is a volume control, and it is the first row of the settings
  grid.
### The e2e suite, corrected: five of the ten failures were mine

The full suite was run at the end and came back **41 passed / 10 failed / 3 skipped** in
14.6 minutes. The ten are five cases in two browsers, and they split cleanly:

**Three were mine, and are fixed.** Two cases open the settings panel by clicking its
summary text, and job 0 renamed that summary to *Camera, sound & accessibility* when it
gained the volume row. One reads the ammo corner for a magazine count at rest, where job 2
made the corner say `BLADE`. All three now pass -- and they are the cost of not running the
whole suite between jobs: the targeted subsets I ran covered what I *thought* I had touched,
and a renamed string is not on that list.

**Two are older than this pass**, and they are the interesting ones -- see below.

### A route deadlock, and the previous section's claim about isolation was wrong

`freezes the frame on a landed blow` and `never freezes the frame with reduced motion on`
both fail inside `fightIntoTheAtrium`, at `expect(await hostiles()).toBeLessThan(2)`. They
fail **in isolation on an idle machine**, and they fail **identically at `f35050b`** -- the
commit before this pass, built and run in a clean worktree. So section 15's "every failing
case passes in isolation" was not true of these two, and the load-average explanation does
not cover them.

What actually happens, instrumented sweep by sweep at 1280x720:

| | hostiles left | wave | player health | player position |
| --- | --- | --- | --- | --- |
| after 1 s of blade | 3 | W1/2 | 114 | `0.0 2.9 -41.3` |
| after 4 s of blade | **2** | W1/2 | 107 | `0.0 2.9 -41.3` |
| after 24 sweeps of blade (6 s) | 2 | W1/2 | 107 | `0.0 2.9 -41.3` |
| after 16 further sweeps of *sustained gunfire* | 2 | W1/2 | 107 | `0.0 2.9 -41.3` |

Nothing moves. Two hostiles of wave 1 are alive and `active` -- they are in the snapshot, so
the HUD counts them -- and from `z = -41.3` the player cannot reach them with a 3.6 m blade,
cannot hit them with a 140 m rifle across sixteen sweeps of yaw, and takes not one point of
damage from them. The room never advances to wave 2, so the encounter cannot complete.

That is a **soft-lock in the shipped route**, not a test problem, and it is the first thing I
would fix next. The obvious suspects are the interaction between `botLeashMetres` (22 m from
a hostile's own spawn) and where the player stops on entering the Atrium, or line of sight
through the arena's own geometry -- both of which would leave exactly this signature: alive,
active, unreachable, and harmless. It wants the two hostiles' ids and positions dumped from
the debug channel, which is a ten-minute job with `?scene=` and the position line that
section 15 added for exactly this kind of hunt.

### A bug this pass did not cause and did not fix

**Holding the blade button makes the sidearm unusable.** Reported by the player as "whenever
I pull my gun out and try to shoot it just switches to the blade", and measured headlessly
over two seconds of each input pattern:

| input | shots fired | in hand |
| --- | --- | --- |
| right button only | **21** | gun, throughout |
| left *and* right button | **0** | blade, throughout |
| right button tapped | 6 | gun, dropping back to the blade between taps |
| one slash, then hold right | 18 | blade for the recovery, then gun |

The mechanism is that the two verbs share one `ActionState`. `updateCombat` starts a light
swing whenever `Action.Slash` is *held* and `meleeTimer` is zero -- which is the pivot's
deliberate rhythm -- and `canFire` refuses to fire while `player.action === 'melee'`. A held
left button therefore re-enters `melee` every 0.24 s and the gun never gets a tick to fire
in. It predates this pass: before `inHand` existed the viewmodel showed the blade in exactly
the same circumstances, because its own gun timer was only ever refreshed by a shot that
could not happen.

The fix I would make is two lines and one design decision: **do not start a new light swing
while `Action.Fire` is held.** The current swing still finishes, the held-slash rhythm is
unchanged, the heavy on `E` keeps its priority as the deliberate verb, and a player with the
left button down who presses the right one gets a shot 0.24 s later. That is a change to the
control scheme rather than a defect fix, so it is written down here rather than taken.

### Mobile, measured rather than asserted

The player's report is that the game is not mobile compatible. Measured on a 390x844
viewport at device pixel ratio 3, with touch, `isMobile`, and an Android Chrome user agent:

- **The run boots and steps.** No page errors, the standby card comes down, the HUD renders
  and the clock advances -- through the `softLocked` fallback in `InputController`, because
  Pointer Lock is either absent or refused. That fallback, written for embedded previews, is
  the seam a touch scheme would attach to.
- **There is no touch input at all.** `InputController` listens for `keydown`, `keyup`,
  `mousedown`, `mouseup` and `mousemove`, and nothing else. No stick, no look drag, no
  buttons: a phone can start a run, stand still in it, and nothing more.
- **It runs at roughly a tenth of real time** in this emulation -- 0.34 s of run clock in
  3 s of wall clock. 390x844 at DPR 3 is a 1170x2532 backbuffer, close to 3 megapixels,
  against a route that measures 307 draw calls and 130k triangles with eight hostiles up.
  `ResolutionController` and the graphics-quality setting exist and would carry a lot of
  this, but a phone needs its own profile and probably a DPR cap.
- **The play frame collides at that width.** The objective line renders *underneath* the
  `SIM/LINK`, `DEBUG` and `EXIT` chrome, and on the menu the action buttons run off the
  right edge -- `Gun builder` is clipped and `Gameplay editor` is off-screen entirely. The
  stylesheet's smallest breakpoint is 900 px; nothing has been designed under it.
- **Portrait is the wrong shape.** A 92-degree vertical FOV in a 390x844 window is a
  letterbox on its side. Landscape plus fullscreen, and probably an orientation prompt, is
  the target.
- **The touch niceties are all absent**: no `touch-action`, no `overscroll-behavior`, no
  `env(safe-area-inset-*)`, no `user-select` guards. Pull-to-refresh and double-tap zoom
  would both fire mid-fight.

So "not mobile compatible" is accurate, and the order of work is: an input scheme first
(nothing else matters without one), then landscape and fullscreen, then a phone performance
profile, then the play frame under 900 px. It is a feature, not a defect -- three to five
sessions of work, and worth deciding whether the game wants it before starting.

- The three visual baselines were not regenerated and did not need to be. If a future audio
  or HUD pass moves them, something is wrong -- that inference is still good.
