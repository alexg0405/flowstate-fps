# Flowstate FPS — state of the game, and a request for a revamp

Paste everything below into ChatGPT. It is self-contained: it describes what the game is,
what it is built from, what has already been decided and why, what has been measured, and
where it is weakest. It ends with the specific questions I want answered.

---

## What I want from you

I am building a browser-native first-person character-action game and I want a **revamp
proposal** — primarily graphics and art direction, but I also want you to challenge the
game design where the visuals cannot fix it.

Please do not give me a generic "how to make a stylised game" answer. This project has
already been through several deliberate passes with recorded reasoning, and the useful
answer is one that **argues with specific decisions listed below** — tells me which are
wrong, which are half-done, and what the highest-leverage next move is. I would rather
have five concrete, costed changes than thirty ideas.

Assume I can implement anything you propose. Assume nothing is sacred *except* the
constraints in the "hard constraints" section, which are physical rather than
preferential.

---

## 1. What the game is

A single-player, first-person **movement + character-action** game that runs entirely in a
browser. One route, called **White Line**, alternating parkour traversal and compact
combat arenas.

**The core loop.** A blade is the primary verb. A heavy swing sweeps a crowd and breaks a
guard. A dash arms invulnerability frames, so an enemy telegraph can be turned into a
perfect dodge. A "flow chain" with ten distinct link kinds is the style meter — traversal
tech and kills both add links, each link raises a multiplier every award is scaled by, and
the chain lapses if nothing extends it inside a window. Kills return health scaled by the
chain multiplier, and there is **no out-of-combat regeneration at all**, so the answer to
being hurt is to fight better rather than to disengage.

**Movement kit.** Momentum-free ground movement (velocity snaps to input and stops the
moment you release), sprint, slide, wall-run, wall-jump, vault, mantle, a dash/air-step on
a double-tapped jump, and a grapple hook that travels a straight line to any static surface
at least 3.5 m away with a manual "pull harder" input on its own key.

**Guns are a secondary**, with a parts bench behind them: four chassis (carbine, SMG,
shotgun, DMR), five part slots (optic, barrel, magazine, grip, stock), every part a bounded
multiplier on the chassis stats, two builds carried into a run with independent magazines.

**Enemies.** Three profiles, twenty-eight hostiles across seven waves in three arenas:
- *ranged* — 100 HP, engages at 18 m, 0.85 s fire interval, 8 damage
- *aggressive* — 120 HP, closes to 2.4 m, 0.6 s interval, 11 damage
- *bulwark* — 200 HP, 6 m, 1.5 s interval, 18 damage, and carries a frontal plate that
  scales incoming damage down inside an arc, so the counter is to get around it

Every shot a bot fires is telegraphed: it commits, announces, and only then resolves the
trace, so breaking line of sight during the window defeats it. That telegraph is the only
warning the player gets and it is what the dodge answers.

**Scoring.** A run clock, a score, a rank, deaths, peak chain, per-arena splits, and a
ghost of your best run to race. A daily "contract" modifier changes the rules.

**Scale.** ~18,700 lines of TypeScript across simulation, render, audio, input, content,
UI and an in-game level editor. 561 unit tests, plus a Playwright end-to-end suite.

---

## 2. Hard constraints — these are physical, not preferences

1. **Browser, WebGL2, three.js r185.** No native, no compute shaders, no WebGPU today.
2. **A 25 MiB art budget, of which 1.93 MiB is currently spent.** Assets are GLB + KTX2
   with hash verification.
3. **The art pipeline is effectively off limits.** There is a Blender script that generates
   every GLB, and running it once shipped visibly broken characters. The established
   precedent since is *generate geometry at runtime in TypeScript* — the city skyline, the
   sky traffic and the player's blade are all runtime-generated.
4. **It must hold 60 fps on a phone.** Auto graphics quality returns `low` on a coarse
   pointer and the render target is capped at a 1280×720 pixel budget there.
5. **The simulation is deterministic at a fixed 60 Hz** and a test proves identical
   trajectories from identical input tapes. Presentation interpolates between steps and may
   never gate the fixed step. Anything you propose that affects gameplay has to live in the
   simulation; anything cosmetic must not touch it.
6. **Everything is synthesised or generated where possible.** The entire audio mix is
   synthesised in the browser — no samples, no middleware, one `AudioContext` — because
   nothing may be downloaded before the player can hear anything.

---

## 3. Where the graphics are now

The art direction is **expressionist Art Deco / neo-noir rendered with
animation-background logic** — the reference is a low-angle city of enormous geometric
masses, cyan and magenta, near-black silhouettes, no contour outlines, shapes separating
through value and colour. Think an animated poster that behaves like a physical place.

A recent pass rebuilt the renderer around that. What it does now:

**One authored tone curve.** The renderer previously used ACES filmic tone mapping at 0.52
exposure and then a grade pass that pushed saturation back up by 1.22 — i.e. it computed a
photograph and then argued with it. There is now a single curve with **no toe** (so a
surface can reach true black), a shoulder applied to **luminance rather than per channel**
(so a driven cyan sign comes out cyan instead of white), and linearity below the knee.

**Banded, hue-shifting light.** Every material is a toon material reading a *coloured*
gradient ramp. Two things are authored per material: how many steps the light is divided
into (3 for architecture, 5 for a hostile, 4 for glass, 2 for signal trim) and what hue a
surface turns as it leaves the light — *cangiante*, so a shadow is blue-green rather than
grey. Cast-shadow colour comes from a deliberately tinted hemisphere light.

Given up on purpose: specular response, environment reflections, clearcoat, sheen,
transmission, and the PMREM environment probe.

**Readability as an explicit budget.** A world of flat masses and near-black shadow
swallows a figure, and the reference has no outlines. So hostiles get a thin fresnel edge
in the room's hue and an *albedo floor* — their authored albedo is near-black by design and
is scaled up (preserving hue) before any light touches it.

**Graphic FX.** An impact is a white angular star for two frames, a hard-edged dark
fracture that outlives it, and flat shards — instead of a soft ring scaling up and fading.
Every instance is generated from its own seed so a held trigger never stamps the same shape
twice. The fracture is the only effect drawn *darker* than what is behind it.

**Camera as an animation system.** Field of view is a vocabulary rather than one effect:
speed widens, a grapple widens further, a slide a little, and landing *compresses* and snaps
back on its own damping. All clamped, all off under reduced motion.

**Masses painted by facing.** Vertex colours decide a surface's tint from which way it
points — pale cyan one side, dark teal another, magenta-lit a third, near-black underneath —
multiplied over whatever light arrives. Applied at two hardnesses: a hard dominant-axis rule
for generated boxy masses, a softer blend for authored art whose normals are smoothed.

**Animation on twos.** Hostile *poses* advance in whole twelfths of a second, with the
remainder carried. Their positions, facing, the camera, the aim and the audio stay fully
continuous — the stepping is presentation only.

**A graphic layer in the play frame.** Three moments turn the frame into a comic panel for
under a second: a wave arriving, a thirty-metre door opening, and going down. Masked hollow
through the middle so nothing lands near the crosshair.

**Rendering cost, measured:** batched drawing takes the worst arena from 292 draw calls to
152, and 163k triangles to 81k.

---

## 4. Where the audio is now (because it shapes the pacing)

Entirely synthesised. Every cue is a driven sub carrying weight, a lowpassed noise "boom"
carrying body, and at most 8 ms of transient for definition. Nothing tonal starts above
200 Hz; the interface deliberately sits *above* the run rather than inside it.

Recent work: every cue is scheduled off the simulation tick it happened on (they were up to
83 ms late and arrived as a cluster); distance is a flight time and an air-absorption
lowpass rather than only a level; there are two reverb rooms crossfaded on how far up the
climb the player is; guns have a mechanical bolt layer that differs per chassis; a shared
HDR window with one importance number per cue decides what is worth a voice in a crowd; a
gated pulse keeps time while a room is live and stops when it is cleared; the whole mix is
in one key with every pitch an interval over a 34 Hz root.

**It is measured.** There is an offline renderer that runs the real audio graph headlessly
and measures it to ITU-R BS.1770-4. A representative fight now renders at **−23.7 LUFS with
true peak −4.4 dBFS** against an industry target of −23 LUFS and a −1 dBFS ceiling. Worst
case is −2.0 dBFS.

---

## 5. Decisions already taken, with reasons — argue with these if you disagree

- **First person, and it stays.** There is no player-body art and the whole viewmodel layer
  assumes a camera holding a weapon.
- **The blade's reach is 3.6 m through a 130° cone.** Judging reach in first person with no
  visible arm is the risk the whole design turns on, and the generous envelope is the
  answer to it. A launcher weapon was prototyped, measured and *deleted* because that reach
  makes vertical displacement meaningless.
- **The blade is generated TypeScript geometry, not an authored asset.**
- **One attack button.** Left mouse attacks with whatever is selected; `1`/`2`/`3` choose
  blade, gun one, gun two; `Tab` cycles. There used to be a 0.95 s timer that drew a gun
  when you fired and put the blade back on its own, which meant the attack button changed
  meaning underneath a player who had not asked for anything. What is in your hands is now
  a choice that holds until you change it.
- **Hitstop and camera effects are presentation only.** The frame freezes; the simulation
  never does.
- **Colour is reserved by gameplay meaning.** Hostiles read cyan or red; the player's own
  signals own the yellow; a bulwark's plate takes hot yellow because it is the one marking
  that must be read *positionally*.
- **The HUD is six readouts in four zones**, with a hard rule that nothing new goes inside
  fifteen degrees of the crosshair (93 px at 720p).
- **Every decorative effect honours reduced motion**, which is both a media query and a
  save-file toggle.

---

## 6. Where I think it is weakest — tell me if I am wrong

1. **One route.** There is a single level. Everything above is in service of about ten
   minutes of content, and I do not know whether the right move is more content, a
   procedural/roguelike structure, or a much shorter and denser experience.
2. **No narrative or context whatsoever.** No characters, no dialogue, no reason to be
   there. The art direction implies a world the game never states.
3. **The environment is a corridor.** The art direction wants "you are tiny, the city is
   enormous," and the reference is an extreme low angle looking up an impossibly tall
   tower. The actual level is mostly a slot between two walls with a skyline visible above
   it. I suspect the *level architecture* is now the limiting factor on the look rather
   than the renderer.
4. **No diegetic transitions.** The art direction calls for scene changes that happen in
   the world — a train filling the frame, a foreground silhouette wiping the scene — and
   there are none. This is level-authoring work, not renderer work.
5. **Enemy variety is three profiles.** They differ in health, speed, range and one shield.
   No enemy changes how the player has to *move*, which in a movement game feels like the
   biggest miss.
6. **No reflections, no rain, no volumetrics.** The reference is a wet neon city. The game
   has neither weather nor anything reflective.

---

## 7. What I am asking you for

Please answer in this order, and be concrete and specific:

1. **The single highest-leverage change** to make the game look closer to the reference,
   given the constraints. Tell me why it beats the alternatives, not just that it is good.
2. **What you would cut.** Which of the graphics decisions above is not earning its cost,
   and what would you spend that budget on instead? Cutting something I have built is a
   valid and welcome answer.
3. **Level architecture.** If the environment is the limiting factor, what does a level
   built *for* this art direction actually look like — in terms of geometry, sightlines,
   verticality and composition? Be specific enough that I could build a blockout from it.
4. **Rain, reflections and weather**, if you think they are worth it: what is the cheapest
   implementation that reads correctly for this style on a phone, and what would you fake?
5. **One enemy** that would change how the player moves rather than how much they shoot.
   Give me its behaviour, its telegraph, and what the counter is.
6. **A costed order of work**, roughly: what is a day, what is a week, what is a month.

If you think the honest answer is that the graphics are fine and the problem is content,
pacing or design, say that plainly and make that case instead. I would rather be told the
premise of my question is wrong than get a polished answer to the wrong question.
