# Handoff: a Persona-style pass over the interface

Paste the block below into a fresh Claude Code session in this repo. It is
self-contained. `AUDIT.md` has the full history of prior work — sections 5–12,
worth skimming, especially the traps in sections 11 and 12.

Repo state: `alexg0405/flowstate-fps`, public, `main` at `030c5ad`, clean tree.

---

```
You are picking up Flowstate FPS, a browser movement-FPS (Three.js + Rapier + React
+ TypeScript). Read AUDIT.md first — it records seven phases of prior work, what was
measured, and several mistakes worth not repeating.

The job: bring the interface closer to the Persona series' UI language — the
Persona 5 / Royal treatment above all, and the sharper geometric register of
Persona 3 Reload where it suits a colder screen. Menus, overlays, transitions and
result screens are the target. The in-play HUD is *not*, for a reason spelled out
under "The tension you have to hold" below.

## Setup and the bar you must hold

    export PATH="$PWD/.tooling/node-v24.18.1-darwin-arm64/bin:$PATH"

All of these must stay green:
- `npm test` — 289 passing / 26 files
- `npm run typecheck` — clean. Run it every time: vitest transpiles WITHOUT
  typechecking, so tests can pass while types are broken.
- `npm run build` — clean
- `FLOWSTATE_STATIC_DIST=1 npm run test:e2e` — 35 passing (Chromium + Firefox)
- `FLOWSTATE_STATIC_DIST=1 npx playwright test --project=chromium tests/e2e/visual.spec.ts`
- `npm run art:validate` — clean, 1.93 MiB of a 25.00 MiB budget

Verify in a real browser at 1280x720 as well as through DOM assertions. Every
screen is reachable without playing: `/` is the menu, `/?mode=editor` the level
editor, `/?mode=game` the run — its pause card is the standby overlay — and
`/?mode=game&scene=finish` drops you straight onto the results screen. Only
`editor` and `game` are read from the URL (`src/App.tsx`), so the gun bench is
reached by clicking `Gun builder` on the menu or in the pause overlay.

## Do not copy Atlus' assets

Implement the *grammar*, not the artwork. No ripped typefaces, sprite sheets, UI
textures, logos or sound effects. Everything you add must be built from CSS, SVG,
canvas-generated textures or the existing synth audio bus. What you are reproducing
is a vocabulary — shear, cut-out edges, screen tone, overshoot, stagger, stamped
confirmations — not a set of files.

## The tension you have to hold

Persona's interface is maximalist: it is loud, dense, asymmetric and in constant
motion. This project spent an entire phase (AUDIT.md §12) taking the HUD from
thirteen modules down to six in four zones, because it was illegible in motion. If
you push Persona's density back onto the play frame you will undo measured work.

So the split is:
- **Menus, overlays, transitions, results, the gun bench** — go all in. There is no
  gameplay cost to a loud menu, and this is where the series' language lives anyway.
- **The in-play HUD** — take the *vocabulary* only: the type treatment, the shear
  angle, the stagger and overshoot of things appearing. Do not add modules, do not
  add persistent decoration, and do not put anything new inside fifteen degrees of
  the crosshair. The four zones in `src/game/Hud.tsx` are load bearing; its doc
  comment explains what each one is for.
- **Kill and chain feedback** is the one exception in the play frame, and the best
  fit in the whole game: a comic burst on a kill and an all-out-attack flourish at a
  high chain are exactly this series' idiom, and the events already exist. Keep them
  transient, keep them off the reticle, and keep them behind `reducedMotion`.

## Architecture rules

- `src/contracts.ts` is the presentation-safe boundary. Extend it; don't bypass it.
- `src/simulation/` owns ALL gameplay state at a deterministic 60 Hz.
  `src/render/`, `src/audio/`, `src/input/` are adapters that own none. A UI pass
  should not need to touch the simulation at all; if you think it does, say why.
- Tuning lives in `src/content/config.ts` and `src/content/modifiers.ts`. Don't
  inline constants at call sites.
- **Every decorative effect honours `reducedMotion`.** The pattern is already in the
  stylesheet: guard the animation with `@media (prefers-reduced-motion:
  no-preference)` and add a `.reduced-motion <selector> { animation: none
  !important; }` escape, because the setting is also a save-file toggle and not only
  a media query. There are 8 of the former and 6 of the latter in `styles.css` to
  copy from. A Persona pass adds a lot of motion; this is the rule that keeps it
  shippable.
- `src/render/palette.ts` is the single source of truth for 3D colour, kept in step
  with the `--cyber-*` properties in `styles.css`. If you change the palette you
  change both, and the 3D layer with it.

## What exists to build on

- `--cyber-yellow #f4ec18`, `--cyber-cyan #08f7ff`, `--cyber-red #ff2d55` on
  `--cyber-void #070b10`. Three saturated accents on near-black. Persona 5 is
  red/black/white and P3R is blue/black/white; **this game's identity is the yellow**,
  which the 3D layer was rebuilt around in AUDIT.md §11. Rotating the whole palette
  to Atlus red would be a different game. Use the existing three and lean on
  *structure* — shear, cut edges, tone — for the resemblance.
- `.display-cut` and `.display-edge` in `styles.css` are the two type tiers added in
  `030c5ad`: heavy condensed face, hollow fill, coloured outline, two hard offsets,
  all in `em` so one declaration works at 8rem and at 1rem. This is already most of
  the way to the series' display type. Extend these rather than starting a third
  system, and note the reason `display-edge` exists: the hollow tier turns to mush
  below about a rem.
- No webfonts are loaded. Type is `Impact, 'Arial Narrow'` for display, `Inter` and
  `ui-monospace` for the rest, all system fallbacks. If you want a closer face you
  have to add font loading, which means a build change, a FOUT story and new visual
  baselines — decide deliberately and say so, don't smuggle it in.
- `src/audio/AudioManager.ts` is a deterministic synth bus with 22 event cases and
  no UI sounds at all. Confirm, cancel, hover and a results-screen stinger are
  cheap to add here and would carry a lot of the feel.
- `GameEvent.kind` in `src/contracts.ts` already includes `kill`, `comboLink`,
  `comboBreak`, `split`, `checkpoint`, `death`, `respawn` and `complete`. The
  feedback hooks you want mostly exist.
- `src/ui/Primitives.tsx` holds the shared vocabulary — `UiPanel`, `Meter`, `Tabs`,
  `Section`, `Tooltip`, `Dialog`, `UiButton`. Reshaping these reshapes the game and
  the editor at once, which is usually what you want.
- `src/App.tsx` routes `menu | game | editor | builder` off one `mode` state, with
  no transition between them. That is the seam a between-screen wipe goes in.

## Items, roughly in order of payoff

### 1 — The results screen
The strongest fit in the game and the place to start. `CompletionState` in
`src/game/GameOverlay.tsx` already computes everything the series' results screen
shows: a letter rank, score, elapsed, signed deltas against the previous best, a
`NEW BEST RUN` / `FASTEST` flag, and per-arena splits with per-split deltas. It
currently renders them as a static grid.

Make it a sequence: lines stagger in on a shear, numbers tick up rather than
appear, the rank letter slams in oversized and settles, the flag stamps. All of it
skippable on a keypress, all of it instant under `reducedMotion`. Nothing here
needs new data.

### 2 — A screen transition
There is no transition between `menu`, `game`, `builder` and `editor` today — the
DOM simply swaps. A sheared wipe carrying the wordmark across the frame is the
single highest-impact addition for the least risk, because no gameplay state
depends on it.

Watch two things: `GameScreen` builds WebGL and Rapier on mount, so the transition
must not delay or double-mount it (`useEffect` there is keyed on `level`), and the
e2e suite clicks straight from one screen to the next — if a wipe blocks pointer
events for 400 ms, ten tests start failing intermittently. Make it
`pointer-events: none` and drive it off CSS animation, not a JS timer that races
React.

### 3 — Menu and overlay chrome
`MainMenu` in `src/App.tsx` and the standby card in `GameOverlay.tsx`. The pieces
that read as this series: panels sheared off-axis rather than aligned to a grid,
cut-out edges instead of straight ones (`clip-path` is already used throughout —
grep for it), a screen-tone or halftone layer over flat colour, elements that
bleed off the edge of the frame instead of fitting inside it, and hover states that
shuffle a row rather than merely tint it.

The standby card has a constraint the menu does not: `Enter run` must stay visible
without scrolling at 1280x720. It only just is — the card already overflows its
container by 25 px below that button (AUDIT.md §12), so any height you add has to
come back out of the blocks above it.

### 4 — Kill and chain flourishes
`comboLink`, `comboBreak` and `kill` events reach `GameRuntime` already, and the
HUD's reticle cluster reads `combo.links` and `combo.multiplier`. A burst on a kill
and a bigger flourish when the chain crosses a threshold belong here. Constraints,
all of them real:
- Nothing new inside ~15 degrees of the crosshair. That budget is 93 px at 720p
  with the game's 92-degree vertical FOV; the numbers are in `Hud.tsx`.
- Transient only. Nothing that persists while the player is moving.
- Behind `reducedMotion`, both branches.
- `tests/ui.test.tsx` has 57 cases across the HUD, the overlays and the bench, two
  of them asserting specifically that the reticle zone holds only the flow-critical
  set and that the modules cut in §12 stayed cut. **Update them, do not delete
  them** — the accessibility work is deliberate and tested.

### 5 — UI audio
Nothing in the mix acknowledges a menu press. `AudioManager` is a deterministic
synth bus; add hover, confirm, cancel, and a results stinger. Keep the deterministic
noise source — `tests/` relies on the audio path staying pure — and keep the
existing hit-confirm and telegraph cues untouched: AUDIT.md §5 records that taking
damage used to play the hit-confirm sound and how much that cost to sort out.

## Traps that already cost real time — read before measuring anything

1. **`npm run typecheck` is not optional.** Vitest transpiles without typechecking.
   Tests pass while types are broken.
2. **Screenshots taken ~2 s after entering a run race the async asset load** and
   come back washed pale. Wait 6 s+. The same scene measured rgb(197,214,210) at
   2.2 s and rgb(31,39,45) at 6 s. `tests/e2e/visual.spec.ts` is immune because
   `openPresentation` waits on the asset responses — prefer that pattern.
3. **`maxDiffPixelRatio` in the visual spec is 0.035**, about 32k pixels. A total
   character-rendering failure once passed inside it. Don't treat a pass as proof;
   tighten it temporarily when you need a real number, then put it back. If a change
   moves the frame legitimately, regenerate the baselines and report the pixel count
   — a stale-but-passing baseline has bitten this repo twice (§9, §12).
4. **The visual baselines hide everything except the canvas**
   (`.game-shell > :not(.game-canvas) { display: none }`), so pure UI work cannot
   move them. If a UI change does move them, something is wrong — find out what.
5. **`sharp`'s `stats()` reads the input image and ignores a pending `.extract()`.**
   Region measurements silently come back as whole-frame means. Materialise the crop
   first: `await sharp(f).extract(box).png().toBuffer()`, then `stats()` on that.
6. **Playwright's actionability checks are sensitive to animation.** An element whose
   box is still moving is "not stable" and `click()` waits for it. Anything that
   animates on mount near a button the e2e suite presses needs to settle fast or be
   `pointer-events: none`. Two tests already time out under load; do not add more.
7. **`reducedMotion` is a save toggle as well as a media query.** Guarding only with
   `@media (prefers-reduced-motion)` leaves the in-game setting doing nothing.
8. **The palette is shared with the 3D layer.** `src/render/palette.ts` and the
   `--cyber-*` properties are two halves of one decision; §11 records what happened
   when they drifted.
9. **Don't touch `tools/art/generate_vertical_slice.py` for a UI pass.** If you do,
   you MUST run `npm run art:build`, which regenerates every GLB — the characters
   shipped visibly broken once for exactly this reason.

---

Work one item at a time. After each, run the full bar above and tell me what you
measured rather than what you expect. Screenshot every screen you touch at 1280x720
and show me. If an item turns out to be a worse idea than it looked — and item 4 is
the candidate — say so and stop rather than shipping it.
```
