# Handoff: finish the three remaining items

Paste the block below into a fresh Claude Code session in this repo. It is
self-contained. `AUDIT.md` has the full history of what was already done and why —
sections 5–11, worth skimming, especially the traps recorded in section 11.

Repo state: `alexg0405/flowstate-fps`, public, `main` at `39961c6`, clean tree.

---

```
You are picking up Flowstate FPS, a browser movement-FPS (Three.js + Rapier + React
+ TypeScript). Read AUDIT.md first — it records six phases of prior work, what was
measured, and several mistakes worth not repeating.

Three items remain. Do them in the order below; each is independent.

## Setup and the bar you must hold

    export PATH="$PWD/.tooling/node-v24.18.1-darwin-arm64/bin:$PATH"

All of these must stay green:
- `npm test` — 262 passing / 24 files
- `npm run typecheck` — clean. Run it every time: vitest transpiles WITHOUT
  typechecking, so tests can pass while types are broken.
- `npm run build` — clean
- `FLOWSTATE_STATIC_DIST=1 npm run test:e2e` — 35 passing (Chromium + Firefox)
- `FLOWSTATE_STATIC_DIST=1 npx playwright test --project=chromium tests/e2e/visual.spec.ts`
- `npm run art:validate` — clean

## Architecture rules

- `src/contracts.ts` is the presentation-safe boundary. Extend it; don't bypass it.
- `src/simulation/` owns ALL gameplay state at a deterministic 60 Hz.
  `src/render/`, `src/audio/`, `src/input/` are adapters that own none.
- Use the existing `SeededRandom` in the simulation, never `Math.random()`.
- Tuning lives in `src/content/config.ts` (`movementProfile`, `comboScoring`,
  `runScoring`, `ghostTrack`, `aimAssist`) and `src/content/modifiers.ts`. Don't
  inline constants at call sites.
- Every decorative effect honours the existing `reducedMotion` setting.
- `src/render/palette.ts` is the single source of truth for 3D colour, kept in step
  with the `--cyber-*` properties in `styles.css`.

## Traps that already cost real time — read before measuring anything

1. **`sharp`'s `stats()` reads the input image and ignores a pending `.extract()`.**
   Region measurements silently come back as whole-frame means. Materialise the crop
   first: `await sharp(f).extract(box).png().toBuffer()`, then `stats()` on that.
2. **Screenshots taken ~2 s after entering a run race the async asset load** and come
   back washed pale. Wait 6 s+. The same scene measured rgb(197,214,210) at 2.2 s and
   rgb(31,39,45) at 6 s. `tests/e2e/visual.spec.ts` is immune because
   `openPresentation` waits on the asset responses — prefer that pattern.
3. **The grade pass runs before `OutputPass` deliberately.** Moving it after is more
   correct in theory and washes the game out in practice; the comment in
   `PostPipeline.ts` explains why. Don't.
4. **`bloomPass.threshold` applies to linear HDR values**, so it must stay near 1.0.
   0.96 washed the frame whenever an emissive strip passed the camera; 0.72 bloomed
   every lit surface.
5. **Art is generated.** `npm run art:build` regenerates the `.blend` sources from
   `tools/art/generate_vertical_slice.py` and re-exports every GLB. If you touch that
   script you MUST rebuild — the characters shipped visibly broken for exactly this
   reason. `validation.minimumRigAttachments` in the catalog now guards it.
6. **`maxDiffPixelRatio` in the visual spec is 0.035**, about 32k pixels. A total
   character-rendering failure once passed inside it. Don't treat a pass as proof;
   tighten it temporarily when you need a real number.
7. **`comboScoring`'s two anti-farm rules are load bearing** (one link per tech per
   chain; no payout on the first link) and both have tests. Read the comment first.
8. **`recoilHoldSeconds` gates both recoil recovery and bloom shedding.** Remove it
   and neither accumulates at any rate that also settles between bursts.

---

## ITEM 1 — Reduce the HUD (AUDIT.md §9; highest user-visible value)

The audit called the HUD illegible in motion at 11 modules. It is now WORSE: phases
2–4 added the death counter, split readout, ghost delta, chain readout, threat
compass and contract label, so `src/game/Hud.tsx` renders roughly 13.

Current modules: vignette, frame, objective (+contract), hitmarker, crosshair, lock
indicator, threat compass, damage layer, grapple readout, telemetry
(elapsed/score/deaths/ghost-delta + motion label + speed + 12-segment spectrum +
split readout), health (heading + value + 12-segment `Meter`), ammo (heading + value
+ weapon strip + 10 pips + reload track), hostiles count, chain rail (caption + combo
readout + 5 chain chips + status), plus the down panel.

Target roughly four zones:
- **Within ~15 degrees of the crosshair** — the flow-critical set: hit confirm,
  threat compass, chain multiplier + window, ghost delta, hook state.
- **Two corners** — one compact health readout, one compact ammo readout.
- **Top** — objective and the day's contract.
- **Pause screen** — everything else.

Cut the redundancy specifically: health is a number AND a 12-segment meter; ammo is a
number AND 10 pips AND a weapon strip; speed is a number AND a 12-segment spectrum.
The five chain chips (DASH/JUMP/AIR/WALL/HOOK) duplicate what the combo multiplier
already tells the player.

`tests/ui.test.tsx` has ~44 cases asserting on these selectors. **Update them, do not
delete them** — the accessibility work (aria labels, roles, keyboard-operable
disclosures) is deliberate and tested. Verify in a real browser at 1280x720, not only
through DOM assertions.

## ITEM 2 — Batch the catalog geometry (AUDIT.md §10)

Baseline to beat: **292 draw calls = 250 main pass + 40 shadow**, from 264 visible
meshes. The main pass is ~1:1 with meshes; nothing is batched. The city, light
pooling, dynamic resolution and shadow casters are already done and measured.

Blockers, all in `GameRenderer.loadVisualAsset`:
- `BatchedMesh` needs one material per batch; the environment assets carry 3–5 each,
  so group by (assetId, materialVariantId, material).
- `applyMaterialVariant` clones materials **per instance** to tint accents, and every
  aligned visual carries a `materialVariantId`. Batching needs one shared material
  per group instead.
- Gate visibility toggles `object.visible` via `assetGateBindings`; a batch needs
  `setVisibleAt`. In `defaultLevel` no aligned visual actually has a gate binding
  (`alignedVisual` returns null for gate primitives) so this path is unexercised —
  keep it correct anyway.

`BufferGeometryUtils.mergeGeometries` is a lower-risk alternative winning the same
draw calls for static geometry, at the cost of per-instance frustum culling. On a
172 m corridor where all 264 visible meshes were already being drawn, culling buys
almost nothing — measure both before choosing.

Measure with `renderer.info.render.calls`; get the main/shadow split by toggling
`renderer.shadowMap.enabled` for a frame. Frame time here is ~1.2 ms, so do NOT claim
a frame-time win you cannot show. Report the draw-call reduction.

## ITEM 3 — Enemy and encounter variety (AUDIT.md §7)

One 172 m corridor, six bots, two profiles differing only in
health/speed/range/interval. **A third profile that also only differs in numbers does
not answer that criticism** — it needs a behaviour that changes how the player
approaches it. Candidates: a shielded type taking reduced damage from the front that
must be flanked, or something that breaks the ground fight.

What it touches:
- `BotProfile` in `src/contracts.ts`; `botProfiles` in `content/config.ts`
- `SpawnDefinition['kind']`, currently `'player' | 'bot-ranged' | 'bot-aggressive'`
  — so `content/schema.ts` and its migration, plus `levelSchema.test.ts`
- The editor's bot-assignment UI in `src/editor/`
- `CharacterPresenter`'s profile→template map. Only two hunter GLBs exist; a third
  silhouette is scriptable in `generate_vertical_slice.py` (see trap 5), or reuse a
  model and differentiate by accent
- `FlowSimulation.updateBotFire` / `damageBot` for the behaviour itself

Then give the three arenas distinct compositions in `content/defaultLevel.ts` instead
of two bots each.

---

Work one item at a time. After each, run the full bar above and tell me what you
measured rather than what you expect. If an item turns out to be a worse idea than it
looked, say so and stop rather than shipping it.
```
