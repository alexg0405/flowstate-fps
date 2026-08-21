# How stylised games build a look, and what this one should steal

**Status: implemented.** All eight items in the table below landed; AUDIT §18 records what
each of them turned into, what was measured, and the one bug that cost the most (`Material.copy`
does not carry `onBeforeCompile`, so every cloned material silently reverted to a stock
shader — the world took the treatment and the hostiles did not). The two things this brief
discusses and the table does not — repainting the catalogued GLB art, and diegetic
transitions like a train filling the frame — were left at first for the reasons given
below. The first was then taken, in §20, once the hard dominant-axis rule was generalised
to a blend that authored normals survive; the second is level-authoring work and remains
untouched.

Research brief, written against the render layer as it stands after AUDIT §17. The premise
is a direction the player stated: the target is **expressionist Art Deco / neo-noir
rendered with animation-background logic**, and the trick is to build the game around that
distinction rather than putting a toon shader on realistic environments.

The constraints are real and they shape every recommendation below. This is `three.js`
0.185 on `WebGLRenderer` in a browser, with a 25.00 MiB art budget of which 1.93 MiB is
spent; the art pipeline is off limits (`AUDIT` trap 4 — running `art:build` shipped visibly
broken characters once, and the precedent set twice since is *generate geometry at
runtime*); three visual baselines guard the frame at a 0.035 diff ratio; and as of §17 the
frame has to hold on a phone, where auto quality now returns `low` and the render target is
capped at a 1280×720 budget. That rules out most of what the industry does *literally* and
almost none of what it does *structurally*, which is the useful part.

Everything below is ordered by what it would buy us, not by how impressive it is.

---

## 1. The renderer is photographic, and three of its stages are fighting each other

This is the finding that reframes the rest, so it goes first.

`GameRenderer` sets `THREE.ACESFilmicToneMapping` at an exposure of **0.52**. ACES is a
*film* curve: its whole job is to take an HDR physically-lit scene and roll it off the way
a camera would, which means desaturating and compressing exactly the pure saturated
primaries this direction is built out of. Then `CyberDuskGrade` pushes saturation back up
by **1.22**, splits the tone cool into the shadows (0.72, 0.86, 1.12) and warm into the
highlights (1.14, 1.06, 0.72), and re-applies 18 per cent of a `smoothstep` contrast curve.
And underneath both, the world is `MeshStandardMaterial` and `MeshPhysicalMaterial` with
metalness from 0.08 to 0.94, roughness from 0.04 to 0.9, normal maps, detail maps and
clearcoat, lit by a sun, a hemisphere fill, two coloured directionals and a PMREM
environment probe at 0.52 intensity.

So the stack is: compute physically plausible colour → apply a curve designed to make it
look photographed → apply a second curve trying to undo the first. The comment in
`PostPipeline` even records the collision — moving the grade after tone mapping "lifts mid
tones instead of crushing highlights, which washes the whole route out", which is a
description of two curves disagreeing about where the mid tones are.

**The cheapest single change available is to stop asking for a photograph.** A neutral or
gently-toed curve at a higher exposure, with the grade's job reduced to *palette* rather
than to *rescue*, would give the primaries back without touching a single material. It is
maybe thirty lines, it is reversible, and it is the one item here that could be done
tomorrow and evaluated against the existing baselines. It will move all three of them,
which is the point.

## 2. Quantised light, and the band count is a per-material decision

The reference for doing this properly in a shipping 3D game is Guilty Gear Xrd: characters
around 40k triangles, **no normal maps at all**, and vertex normals modified *by hand* so
the shading reads correctly from any light angle ([Motomura, GDC
2015](https://www.gdcvault.com/play/1022031/GuiltyGearXrd-s-Art-Style-The), [Game
Developer](https://www.gamedeveloper.com/art/see-i-guilty-gear-xrd-i-s-striking-2d-3d-art-deconstructed-at-gdc-2015)).
The lesson is not "use a toon shader". It is that the *inputs* to lighting were authored as
art. Hi-Fi Rush is the modern counterpart and the closer analogue for a game that also
wants a lit 3D world: a deferred toon renderer carrying deferred lights, volumetric fog,
ambient occlusion, GI and reflections, all in service of a flat 2D read, at 60 fps
([Tanaka & Komada, GDC 2024](https://gdcvault.com/play/1034330/3D-Toon-Rendering-in-Hi),
[80.lv](https://80.lv/articles/the-making-of-hi-fi-rush-s-3d-toon-rendering-style)). Both
prove the same thing: you do not have to give up modern lighting to stop it looking
photographic.

The player's own proposal — three or four broad zones with slightly softened borders, and
the count varying by material (glass four, concrete three, characters five) — is the right
shape, and the per-material part is the half most implementations skip. Characters need
more steps than architecture because they need *volume*; architecture needs fewer because
it needs to read as a plane.

We have nothing of the sort. There is no `MeshToonMaterial`, no `gradientMap`, no
`onBeforeCompile`, no custom material anywhere: every lit surface in the game is stock
`three.js` PBR. The practical seam in this codebase is `MaterialLibrary`, which already
owns every world material behind an id and already clones and decorates imported GLB
materials in one place — a quantisation hook installed there reaches the entire world,
including the authored art, without touching a presenter.

**Do the quantisation maths as a pure module.** This repo has a precedent it keeps
returning to: `ResolutionController`, `visualBatching`, `citySkyline` and `hitstop` are all
pure and all unit tested precisely because `GameRenderer` needs WebGL to construct and
therefore cannot be reached from a test. A band table — thresholds, softness, per-material
counts — is exactly that kind of thing, and it is the only way any of this becomes
assertable rather than a screenshot argument.

## 3. Colour in the shadow, not the absence of colour

Painters have had a word for this for five hundred years: *cangiante*, where a surface
changes **hue** as it turns away from the light rather than merely getting darker
([Wikipedia](https://en.wikipedia.org/wiki/Cangiante)). The game-side write-ups make the
same point from the other end — monochrome shadows are the default a renderer gives you,
and tinting them is a deliberate style decision rather than a physical one ([Game
Developer](https://www.gamedeveloper.com/programming/forget-monochrome-shadows-go-colored-instead)).

We are already halfway here and it is worth being precise about which half. `setupLighting`
has a cyan directional at 0.8 and a red-pink bounce at 0.42, and the hemisphere fill is
`#5f6fa8` over `#0a0e14` — so there is coloured light arriving from several directions.
What there is not is a *shadow colour*: the sun's shadow map multiplies whatever the
ambient terms give it, so an unlit face is the same hue as a lit one at a lower value. That
is the difference between "coloured lights in the scene" and "this face is teal and that
face is black because the silhouette is better that way".

The change is one term in the quantisation from §2 — a shadow **tint** per material rather
than a shadow **level** — and it is where most of the visible payoff of that work actually
lives. It also composes with the palette we already have: `palette.ts` is nine colours and
is the single source of truth shared with the `--cyber-*` properties in `styles.css`.

## 4. Composition lives in the geometry, and the skyline already proves we can do it

The player's hierarchy — silhouette → colour mass → lighting → architectural rhythm → tiny
details — is a description of `citySkyline.ts`. That module exists because the city used to
be one rounded box instanced 180 times, so "a skyline of 180 towers read as one shape
repeated"; the fix was six archetypes built as **stacks of blocks in normalised space**,
merged to one draw call per archetype, with window panes placed from the same block list so
they follow a setback instead of floating off it. Silhouette first, facade second, detail
never. It is pure, it is tested, and it is the closest thing in this repo to the philosophy
the direction is asking for.

The route itself is authored the other way up: invisible gameplay collision plus catalogued
visual instances, with surface detail carried by tiling KTX2 sheets (four of them, 643.9
KiB) and normal maps. That is a materials-and-props pipeline, not a planes-and-masses one.

The industry answer for painting art direction into geometry without a texture budget is
vertex colour, and it is well-trodden: colour data straight on the mesh at no extra memory
cost, three channels of gradient to spend, widely used to bake world lighting on platforms
with no lightmap budget ([Polycount](https://polycount.com/discussion/157219/increasing-mobile-game-performance-through-vertex-color-article),
[A Vertex Coloring Primer](https://vertexcoloring.webflow.io/)). For us it is more
attractive than usual for two reasons: geometry is already generated at runtime in several
places, so the "painting" is a function rather than an art task; and it costs nothing on
the mobile budget §17 just introduced.

The honest caveat: our world art is authored GLBs and the pipeline that regenerates them is
the one trap 4 forbids touching. So vertex-painted graphic identity is available cheaply for
*generated* geometry — the skyline, the route's primitives, the blade — and is a much
larger conversation for the catalogued art. That split should be decided before, not
during.

## 5. The camera is part of the art direction

The reference image is shot from extremely low down with verticals converging hard, and
that perspective is doing as much work as the palette. The player's proposal — FOV as an
animation system, narrowing on an architectural reveal and widening on a rooftop jump —
lines up with what the FOV literature says about perception: a wider field makes a player
feel they are travelling faster because more of the world rushes past in the periphery,
and the standing advice is to widen for speed, narrow for aiming, clamp the extremes and
ease the transitions so nobody is made ill by it
([Zigurous](https://docs.zigurous.com/com.zigurous.camerasystem/manual/fov-kick/),
[Effects of Field-of-View in First-Person Video Games,
Blekinge](https://www.diva-portal.org/smash/get/diva2:818863/FULLTEXT01.pdf)).

We have exactly one FOV behaviour: `SPEED_FOV_KICK = 11` degrees, damped at a rate of 8
toward `snapshot.camera.fov + speed * 11`. It is a good effect and it is the only one. There
is no authored FOV anywhere — no reveal, no compression on landing, no narrowing while
aiming beyond what the ADS zoom does to the weapon.

The important constraint is one this repo has already written down twice: aim and camera
control are the two things that must stay a precision instrument. The player's own
stylisation table puts aim/camera movement at "low" and hit detection at "none", which is
the correct answer and matches the existing rule that the simulation steps deterministically
at 60 Hz and presentation may never gate it. So FOV authoring belongs in `GameRenderer`
alongside the speed kick, driven off snapshot state, and never anywhere near
`FlowSimulation`.

## 6. The graphic layer, which is the cheapest thing on this list and the most visible

Persona 5 is the standing proof that a graphic layer can *be* the identity: high-contrast
colour, angular shapes, and motion design used not just for appeal but to direct attention
inside a busy frame, with scene transitions that are themselves authored animations rather
than fades ([Olszewska](https://medium.com/@kinga.olszewska/interface-so-good-that-people-make-cosplay-of-it-persona-5-ui-controversial-yet-brilliant-ac1ec4b95229),
[Wen](https://jiaxinwen.wordpress.com/2017/04/27/the-ui-design-of-persona-5/)).

This is the layer where we are furthest along and least aware of it. `ScreenWipe` already
transitions between screens with an authored mark rather than a fade. The chain flourish is
already a transient full-frame graphic event with its paint masked out of the middle 170 px
so it cannot touch the reticle cluster. `hitstop` already freezes the frame on a landed
blow, on its own tested clock. The interface is already flat blocks of yellow, cyan and hot
pink over near-black. Everything the direction asks for at the *interface* level exists.

What does not exist is any of it **in the world**. `FxPresenter` builds muzzle flashes,
tracers, impacts and sparks as additive `MeshBasicMaterial` quads and rings at `#ffe9a8`,
`#ffffff`, `#ffd58c` and `#55f4ff`, fading opacity over their lifetime. That is a
particle-and-glow vocabulary, not a graphic one. The player's proposal — a shotgun as a
huge triangular burst, a sniper as a thin white slash across the frame, an impact as a
white flash then a black angular fracture then a few cyan shards — is a *different set of
shapes on the same nodes*. `FxPresenter` already pools its meshes by slot and already
drives them from `GameEvent`s. Swapping the geometry and the envelopes is contained work
with no dependencies on §1–§4 at all.

Two guardrails this repo has already paid for. Every decorative effect honours
`reducedMotion`, guarded both by a media query and by a save-file class, and hitstop and
shake do the same in code — a graphic layer that ignored it would be a regression, not a
feature. And the reticle-cluster rule holds: nothing new inside fifteen degrees of the
crosshair, which is 93 px at 720p.

## 7. Step what can be stepped, and nothing else

*Animating on twos* is the technique the player is reaching for, and Spider-Verse is its
best-known modern use: the base animation drops every second frame, and the film uses the
choice **narratively** — Miles is on twos while Peter is on ones, and Miles moves to ones as
he gains competence ([Bloop Animation](https://www.bloopanimation.com/spiderman-into-the-spider-verse-2d-or-3d/),
[Marilajane](https://marilajane.substack.com/p/into-the-spider-verse-animation-techniques)).

The player's own split is the correct one and it is worth restating in this repo's terms,
because it maps cleanly onto a boundary that already exists. The simulation steps at a
fixed 1/60 s and `tests/simulationReplay.test.ts` proves identical trajectories from
identical input tapes; presentation interpolates between steps. So *stepping is a
presentation decision*, and it can be applied per presenter: `CharacterPresenter` could
sample poses on twos while the camera, the viewmodel and the input path stay continuous.
`hitstop` is already a presentation-only freeze that the simulation does not see, so the
precedent for "the frame stops and the world does not" is established and tested.

What must not be stepped: aim, camera, hit registration, and the audio — §17 just spent a
pass making cues land on the tick they happened on to within a sample, and quantising them
to anything would undo it.

## 8. Readability is a budget, and it is already partly spent

Sable's team hit the exact failure mode this direction risks: flat shading makes depth hard
to read, and their answer was layering — lighting, fog and lines added back specifically so
players could tell where they stood relative to a surface ([Game
Developer](https://www.gamedeveloper.com/marketing/how-shedworks-refined-the-art-of-sable-in-pursuit-of-readability)).
A neo-noir city where walls collapse to near-black has the same problem twice over, because
it also has to keep eight hostiles legible inside it.

We are in better shape here than anywhere else, because the colour-as-gameplay-signal rule
already exists and is already enforced: `hostileAccent` reads cyan for ranged, red for
aggressive and hot yellow for the bulwark — and the comment records *why* the bulwark gets
the hot yellow, which is that its plate is the one hostile marking the player must read
positionally. `surfaceAccent` does the same for traversal. The palette rule in the
architecture notes is explicit: hostiles read cyan or red, the player's own signals own the
yellow.

So the player's proposed reservation — environment cyan/teal/pink/black, hostile tech
red-orange, friendly tech pale blue, interactive warm yellow — is a *retune* of a rule this
codebase already keeps, not a new one. The item that does not exist is the value budget:
more bands for characters than for architecture, and diegetic rim light taking its hue from
the room rather than a uniform outline. That falls straight out of §2 if the band count is
per material, which is the argument for making it per material.

## 9. Rain, reflection, and letting black be black

Three smaller notes, grouped because none of them justifies its own pass.

**Rain** is the one place where a mixed-fidelity approach is unambiguously right: real
particles near the player, screen-aligned streaks at mid distance, scrolling layers far
away. It is also the one place where an *illustrative* exaggeration is nearly free — rain
turning cyan for two frames on a lightning flash is a uniform, not a simulation.

**Reflections** should get worse on purpose. A puddle carrying a pink sky, a black building
and one cyan light with none of the detail between them is both more correct for the style
and cheaper than what a reflection probe would give us — and cheaper matters now that §17
has put the game on phones.

**Black** is a rendering decision the current stack actively prevents. ACES at 0.52 exposure
lifts and rolls the bottom end; a photographic curve is designed never to let a surface go
to nothing. Letting a wall collapse to something near `#03070a` requires §1 first, which is
another reason §1 is first.

---

## What I would do next, cheapest first

| # | Change | Why it is worth it |
| --- | --- | --- |
| 1 | **Stop tone mapping like a camera.** Replace ACES + the compensating grade with one authored curve, and reduce `CyberDuskGrade` to palette | The stack currently computes a photograph and then argues with it. Thirty lines, reversible, and it is what lets black be black and the primaries be pure. Everything below looks better through it. |
| 2 | **A graphic FX vocabulary in `FxPresenter`** — angular flashes, slashes, fracture shards | The most visible change per hour on this list, self-contained, no dependency on the shading work, and the pooling and event wiring already exist. |
| 3 | **Quantised light as a pure, tested module**, installed once in `MaterialLibrary`, with the band count per material | The foundation. Pure so it can be asserted rather than screenshotted, and installed in the one place that already owns every world material. |
| 4 | **Shadow tint per material**, not shadow level | Where most of item 3's visible payoff actually is, and one extra term once item 3 exists. |
| 5 | **FOV as an authored system** in `GameRenderer`, alongside the speed kick | Perspective is half of why the reference image works, and we have one effect where there should be a vocabulary. Cheap, and it must stay out of the simulation. |
| 6 | **Vertex-painted graphic identity for generated geometry** — skyline, route primitives, blade | Free on the memory budget, composes with item 3, and stops short of the authored GLBs deliberately. Decide the split with the catalogued art *before* starting. |
| 7 | **Stepped character animation on twos**, camera and input untouched | The signature of the whole idea, and the riskiest to feel: it is the one item that can make a responsive game feel unresponsive if the boundary slips. |
| 8 | **World transitions** — foreground wipe, flash match cut, graphic freeze frame | The most ambitious and the most easily overused. Ten to twenty across a campaign, not one every five minutes. |

Items 1, 3, 4 and 6 are engineering with a defensible right answer once the direction is
agreed. Items 2, 5, 7 and 8 are design and should be measured against a player who can see
them.

Two things to settle before any of it starts. **The visual baselines will move**, by design
and probably on item 1 — the standing inference that "if audio or UI work moves them,
something is wrong" survives, but the three snapshots will need regenerating, which needs
`--timeout=150000`. And **the mobile profile added in §17 is now a constraint on this
work**: auto quality returns `low` on a coarse pointer and the render target is capped at a
1280×720 budget, so anything here that costs a full-screen pass has to justify itself twice.

## Sources

- [Guilty Gear Xrd's Art Style: The X Factor Between 2D and 3D (Motomura, GDC 2015)](https://www.gdcvault.com/play/1022031/GuiltyGearXrd-s-Art-Style-The)
- [See Guilty Gear Xrd's striking 2D/3D art deconstructed at GDC (Game Developer)](https://www.gamedeveloper.com/art/see-i-guilty-gear-xrd-i-s-striking-2d-3d-art-deconstructed-at-gdc-2015)
- [3D Toon Rendering in Hi-Fi RUSH (Tanaka & Komada, GDC 2024)](https://gdcvault.com/play/1034330/3D-Toon-Rendering-in-Hi)
- [The Making of Hi-Fi Rush's 3D Toon Rendering Style (80.lv)](https://80.lv/articles/the-making-of-hi-fi-rush-s-3d-toon-rendering-style)
- [Forget Monochrome Shadows → Go Colored Instead (Game Developer)](https://www.gamedeveloper.com/programming/forget-monochrome-shadows-go-colored-instead)
- [Cangiante (Wikipedia)](https://en.wikipedia.org/wiki/Cangiante)
- [Stylized Shadows (DeCoro et al., Princeton)](https://pixl.cs.princeton.edu/gfx/pubs/DeCoro_2007_SS/styleshadows.pdf)
- [Increasing Mobile Game Performance Through Vertex Color (Polycount)](https://polycount.com/discussion/157219/increasing-mobile-game-performance-through-vertex-color-article)
- [A Vertex Coloring Primer](https://vertexcoloring.webflow.io/)
- [How Shedworks refined the art of Sable in pursuit of readability (Game Developer)](https://www.gamedeveloper.com/marketing/how-shedworks-refined-the-art-of-sable-in-pursuit-of-readability)
- [Persona 5 UI, controversial yet brilliant (Olszewska)](https://medium.com/@kinga.olszewska/interface-so-good-that-people-make-cosplay-of-it-persona-5-ui-controversial-yet-brilliant-ac1ec4b95229)
- [The UI Design of Persona 5 (Wen)](https://jiaxinwen.wordpress.com/2017/04/27/the-ui-design-of-persona-5/)
- [Spider-Man: Into the Spider-Verse — 2D or 3D? (Bloop Animation)](https://www.bloopanimation.com/spiderman-into-the-spider-verse-2d-or-3d/)
- [Into the Spider-Verse: Animation Techniques and Details (Marilajane)](https://marilajane.substack.com/p/into-the-spider-verse-animation-techniques)
- [FOV Kick (Zigurous Camera System)](https://docs.zigurous.com/com.zigurous.camerasystem/manual/fov-kick/)
- [Effects of Field-of-View in First-Person Video Games (Blekinge Institute of Technology)](https://www.diva-portal.org/smash/get/diva2:818863/FULLTEXT01.pdf)
- [Non-photorealistic rendering (Wikipedia)](https://en.wikipedia.org/wiki/Non-photorealistic_rendering)
