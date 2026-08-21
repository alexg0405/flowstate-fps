# How shooters build their mixes, and what this one should steal

**Status: implemented.** The seven-item table at the end landed in the pass AUDIT §17
records, and the two items discussed above it but left out of the table -- the **tail**
layer in §1 and the **round-robin variation** in §7 -- landed in §19. Nothing in this brief is
outstanding. The one thing it could not have known -- that the mix measured about eight
decibels under the industry target -- was found by the offline meter built for item 2 and
fixed in §20: the mix now renders a fight at -23.7 LUFS with true peak at -4.4 dBFS.


Research brief, written after the pass in AUDIT §16. The mix here is **entirely synthesised
in the browser** -- no samples, no middleware, one `AudioContext`, and a hard rule that
nothing is downloaded before the player can hear anything. That constraint rules out most of
what the industry does *literally* and almost none of what it does *structurally*, which is
the useful part.

Everything below is ordered by what it would buy us, not by how impressive it is.

---

## 1. The five-layer weapon, and we are missing two of them

The standard AAA gunshot is not three layers, it is **five**: body, transient, sub/LFE,
mechanical, and tail, each routed and rendered independently ([Kilborn / Pro Sound
Effects](https://blog.prosoundeffects.com/how-to-sound-design-first-person-shooter-gunshot-sound-effects-with-mark-kilborn),
[Arcella Sound](https://www.arcellasound.com/post/aaa-weapon-sound-design-architecting-modular-combat-audio-for-xdev-pipelines)).
We have three: `sub`, `boom` (body) and `tick` (transient).

**Mechanical** is the bolt, the hammer, the casing. It is the layer that makes a gun sound
like a *machine* rather than an event, it is deliberately randomised in pitch and level to
avoid "machine-gunning" fatigue, and it is the cheapest thing on this list to synthesise: two
band-limited noise clicks in the 700 Hz–2 kHz range, one on the shot and one 40–70 ms after
it. It is also the only layer that could differ **per chassis**, which would finally make the
gun bench audible -- fitting a drum magazine currently changes the silhouette and nothing
else.

**Tail** is the environment, isolated from the shot so the engine can crossfade indoor
against outdoor tails from raycasts or trigger volumes. We have one generated convolution
reverb with three fixed send levels, which is a single room for the whole route -- and the
route is a bunker corridor *and* an open rooftop deck. The level already knows which.

## 2. HDR audio: author a range far wider than the speaker, then let a window pick

DICE's Frostbite tags every asset with a loudness in **dB SPL across the whole range of
hearing** and relies on a sliding-window compressor to scale it back to something a living
room can play. Loudness *is* priority: the window rises to encompass the loudest thing
sounding, sounds below the floor are culled, and relative levels are preserved -- so soft
sounds are inaudible while a tank fires and audible again a second later ([Frostbite via
SlideShare](https://www.slideshare.net/slideshow/how-high-dynamic-range-audio-makes-battlefield-bad-company-go-boom-1292018/1292018),
[Designing Sound on HDR in Wwise](https://designingsound.org/2013/06/21/finding-your-way-with-high-dynamic-range-audio-in-wwise/)).

We have a limiter and hand-authored gains between 0.013 and 0.17, plus two ad-hoc caps --
`MAX_IMPACTS_PER_BATCH` and `MAX_KILLS_PER_BATCH`. Those caps are HDR, badly: they are the
right instinct implemented per case. The generalisation is one number per cue -- an
importance -- and one shared window that suppresses anything more than N dB under the loudest
recent voice. It would replace both caps, and it is the thing that keeps a crowd of eight
from turning the mix into porridge without anyone hand-tuning eight levels.

## 3. Overwatch: the mix is a gameplay signal, and threat is the parameter

Blizzard bucket enemies by whether they are *looking at you*, *shooting at you* and how close
they are, then drive volume and filtering off that bucket with RTPCs: an enemy in the top
bucket is **7 dB louder** than the same enemy in the third, and ultimates get a flatter,
higher curve because they must always be heard ([Game
Developer](https://www.gamedeveloper.com/audio/video-how-i-overwatch-i-was-designed-so-people-could-play-by-sound-),
[PCGamesN](https://www.pcgamesn.com/overwatch/overwatch-devs-on-creating-a-game-you-can-play-by-sound-and-announcing-dolby-atmos-support)).

Our nearest equivalent is `placement()`, which knows distance and bearing and nothing about
intent. The simulation already computes exactly the missing thing: a bot has a `fireArcCosine`
gate, a `windupSeconds` telegraph and a leash. A hostile that is *about to shoot you* should
be several dB up on one that happens to be nearby, and the telegraph -- the only warning in
the game -- is the cue to spend that on. Inverted, it is also a cull: a marksman shooting at
a wall you are behind can go quiet.

## 4. Crack and thump: distance is a delay and a lowpass, not just a level

Real gunfire arrives as two events. The supersonic **crack** travels with the bullet, the
**thump** is the muzzle blast, and the gap between them grows with range -- experienced
listeners range a shooter by it. High frequencies are absorbed far faster than low ones, so a
distant shot is a muffled boom with no edge at all
([MaxVelocityTactical](https://maxvelocitytactical.com/crack-thump/), [Southampton
ePrints](https://eprints.soton.ac.uk/390601/1/SA80manuscript_3.pdf)).

We attenuate with distance and switch reverb send at 16.5 m. We do not lowpass with distance
and we do not delay anything. Both are a few lines: air absorption is the `boom` cutoff
scaled by distance, and the delay is `distance / 343` seconds -- 116 ms at 40 m, which is
audible, free, and turns "something fired somewhere" into "something fired *over there*".
`tone` already takes a delay; `sub` and `noise` do not, and should.

## 5. Adaptive music: vertical layering is what we already built, and the next step is time

The two standard techniques are **vertical remixing** (layers fading in and out on a gameplay
parameter) and **horizontal resequencing** (reordering material by intensity bucket), and the
good soundtracks use both ([Splice](https://splice.com/blog/interactive-music-system-video-games/),
[The Game Audio Co](https://www.thegameaudioco.com/making-your-game-s-music-more-dynamic-vertical-layering-vs-horizontal-resequencing)).
Just Cause 4 fades instrument layers on live enemy count and shuffles segments inside an
intensity category so a long fight does not loop.

Our bed *is* vertical remixing: floor, colour note and movement layer on threat, speed and
chain. What it has no concept of is **time** -- there is no pulse anywhere in this game. A
slow, quiet gated pulse (a filtered noise or a muted fifth on eighths) keyed to the room's
intensity would give the mix a spine, and it is the single biggest difference between what we
have and what a player would call "a soundtrack". Two warnings: gameplay cues must never be
quantised to it (latency is the enemy, see §6), and the pulse has to *stop* when a room is
cleared or it becomes the thing the player mutes.

Ghostrunner -- the closest comparable, first-person, cyberpunk, blade-first -- is worth noting
for what it does *not* do: its team run organic material (throat singing, taiko, live
instruments) through modular synthesis rather than synthesising from scratch, precisely
because pure synthesis reads as clean ([Soundsphere
interview](https://www.soundspheremag.com/features/ghostrunner-2s-composer-and-lead-sound-designer/)).
We cannot ship samples, but we can synthesise *imperfection*: noise-modulated pitch drift,
inharmonic partials for the plate, and ring modulation to break up the sine layer.

## 6. Latency is a design constraint with published numbers

Honkai Impact 3 targets sound playback within **12 ms** of the input; past **20 ms** players
report delay; and holding audio/haptic sync error under **15 ms** measurably improved action
confirmation speed by 22 per cent
([COGconnected](https://cogconnected.com/2026/06/making-gameplay-feel-more-responsive-using-sound/)).
Academic work on impact feel puts hit stop, **sound coherence** and camera control as the
three features that make or break the read -- and says a failure in any one of them ruins it
([arXiv 2208.06155](https://arxiv.org/pdf/2208.06155)).

This is the most concrete criticism I can make of our own mix. `AudioManager.consume` is
called once per *rendered* frame with the events of up to four simulation steps, and every
voice is scheduled at `currentTime` -- so a hit that happened on the first of four steps is
played up to 50 ms late and *simultaneously* with a hit from the fourth. The fix is exactly
the kind of thing this codebase is set up for: events carry `event.tick`, the step is a fixed
1/60 s, so each cue can be scheduled at `now + (tick - firstTick) / 60`. Sample-accurate,
deterministic, and it makes a burst read as a rhythm instead of a cluster. Hitstop freezing
the frame while the audio does not is the same class of problem -- the visual and the audible
impact should be coherent, and right now only one of them stops.

## 7. Variation: anything heard more than twice needs it, and pitch is the weakest knob

The rule of thumb is blunt -- any sound heard more than twice needs randomisation, via
round-robin containers, pitch and volume randomisation, and multiple source variants
([Audiokinetic voice/instance
guidance](https://www.audiokinetic.com/en/courses/wwise251/?id=Lesson3_Platform_Voice_Instance_Limits_and_Volume_Thresholds/),
[Game Audio Resource](https://gameaudioresource.com/2019/08/27/chapter-16-b-balancing-optimisation/)).

We hash a stable variation per event id -- good, and better than random, because the same
event sounds the same on a replay. But it varies *pitch* (2 per cent tonal, 5.5 per cent
noise) and pitch is the least audible knob on a 5 ms transient. Decay length and filter Q are
far more audible at these durations, and structure is more audible still: the viewmodel
already alternates swing direction so two consecutive slashes read as a combination, and the
audio does not alternate anything. Round-robin two tick spectra per swing and the blade stops
sounding like one sample.

## 8. Voice limiting is not an optimisation, it is a mixing tool

Middleware ships playback limits, virtual voices and priority precisely so that the loud and
important survive and everything else is culled before it is even rendered
([Audiokinetic](https://blog.audiokinetic.com/audio-optimization-practices-in-scars-above/)).
We have no global cap at all: every cue builds an oscillator, a shaper, a filter, a gain and
sometimes a panner, and tears them down on `onended`. Eight hostiles firing at 0.85 s
intervals plus impacts plus a crowd of kills is a real node churn, and the mix has no way to
decide that the ninth simultaneous surface tick does not matter. One priority-ordered
concurrency cap protects the mix and the frame at once.

## 9. Loudness: the industry has a number and we have never measured ours

Games target **-23 LUFS ±2** measured over 30 minutes of representative play, with true peak
never above **-1 dBFS** ([AES
TD1004.1.15-10](https://www.aes.org/technical/documents/AESTD1004_1_15_10.pdf),
[Audiokinetic loudness
series](https://audiokinetic.com/en/blog/loudness-processing-best-practices-series-chapter1-loudness-measurement-part1)),
with emphasis in games on short-term and max-short-term loudness rather than the long
average, because no asset lasts 30 minutes
([Designing Sound](https://designingsound.org/2013/02/28/loudness-in-game-audio/)).

This is the answer to the standing problem that **whoever works on this mix cannot hear it**.
An `OfflineAudioContext` can render the real graph against a scripted event tape and compute
true peak and short-term loudness in a unit test. That turns "I think the kill is too loud"
into a number, and it would catch the class of bug that a synth mix is most prone to: a cue
that clips the output when three of it land together.

---

## What I would do next, cheapest first

| # | Change | Why it is worth it |
| --- | --- | --- |
| 1 | **Schedule cues off `event.tick`** rather than at `currentTime` | Fixes a real 0–50 ms error and a burst that arrives as a cluster. Pure win, no design decision. |
| 2 | **Measure the mix offline** -- true peak and short-term loudness in a test | Ends mixing blind. Guards against clipping when cues stack. |
| 3 | **Distance as delay and lowpass**, not only level and send | Turns direction into *distance*. A few lines; `sub` and `noise` need a delay argument. |
| 4 | **A mechanical layer**, varying per chassis | Makes the gun a machine, and makes the bench audible for the first time. |
| 5 | **Threat-weighted telegraphs** off the bot's own firing gate | The mix starts telling the player which of eight hostiles is about to hurt them. |
| 6 | **One HDR window plus a priority cap**, replacing the two per-case caps | The generalisation of what we already do by hand, and what keeps a crowd legible. |
| 7 | **A pulse in the bed**, keyed to room intensity, stopping when the room clears | The largest perceptual jump available, and the riskiest -- a pulse you notice is a pulse you mute. |

Items 1, 2, 3 and 6 are engineering with a right answer. Items 4, 5 and 7 are design and
should be measured against a player who can hear them.

## Sources

- [Mark Kilborn on FPS gunshot design (Pro Sound Effects)](https://blog.prosoundeffects.com/how-to-sound-design-first-person-shooter-gunshot-sound-effects-with-mark-kilborn)
- [The Anatomy of Combat: Modular AAA Weapon Sound Design (Arcella Sound)](https://www.arcellasound.com/post/aaa-weapon-sound-design-architecting-modular-combat-audio-for-xdev-pipelines)
- [METAL EDEN's Weapons Sound Design (Audiokinetic)](https://www.audiokinetic.com/en/community/blog/metal-eden-weapons-sound-design/)
- [How HDR Audio Makes Battlefield: Bad Company Go BOOM (DICE, SlideShare)](https://www.slideshare.net/slideshow/how-high-dynamic-range-audio-makes-battlefield-bad-company-go-boom-1292018/1292018)
- [Finding Your Way With High Dynamic Range Audio In Wwise (Designing Sound)](https://designingsound.org/2013/06/21/finding-your-way-with-high-dynamic-range-audio-in-wwise/)
- [How Overwatch was designed so people could play by sound (Game Developer)](https://www.gamedeveloper.com/audio/video-how-i-overwatch-i-was-designed-so-people-could-play-by-sound-)
- [Overwatch devs on creating a game you can play by sound (PCGamesN)](https://www.pcgamesn.com/overwatch/overwatch-devs-on-creating-a-game-you-can-play-by-sound-and-announcing-dolby-atmos-support)
- [Crack & Thump (Max Velocity Tactical)](https://maxvelocitytactical.com/crack-thump/)
- [Factors affecting sound exposure from firing an SA80 rifle (Southampton)](https://eprints.soton.ac.uk/390601/1/SA80manuscript_3.pdf)
- [How to build an interactive music system for video games (Splice)](https://splice.com/blog/interactive-music-system-video-games/)
- [Vertical Layering vs. Horizontal Resequencing (The Game Audio Co)](https://www.thegameaudioco.com/making-your-game-s-music-more-dynamic-vertical-layering-vs-horizontal-resequencing)
- [Ghostrunner 2's composer and lead sound designer (Soundsphere)](https://www.soundspheremag.com/features/ghostrunner-2s-composer-and-lead-sound-designer/)
- [Making gameplay feel more responsive using sound (COGconnected)](https://cogconnected.com/2026/06/making-gameplay-feel-more-responsive-using-sound/)
- [What Features Influence Impact Feel? (arXiv 2208.06155)](https://arxiv.org/pdf/2208.06155)
- [Platform Voice Instance Limits and Volume Thresholds (Audiokinetic)](https://www.audiokinetic.com/en/courses/wwise251/?id=Lesson3_Platform_Voice_Instance_Limits_and_Volume_Thresholds/)
- [Audio Optimization Practices in Scars Above (Audiokinetic)](https://blog.audiokinetic.com/audio-optimization-practices-in-scars-above/)
- [AES TD1004.1.15-10: Loudness for interactive and linear audio](https://www.aes.org/technical/documents/AESTD1004_1_15_10.pdf)
- [Loudness Processing Best Practices (Audiokinetic)](https://audiokinetic.com/en/blog/loudness-processing-best-practices-series-chapter1-loudness-measurement-part1)
- [Loudness In Game Audio (Designing Sound)](https://designingsound.org/2013/02/28/loudness-in-game-audio/)
- [Drum Synth Sound Design: Kick & Snare (ModeAudio)](https://modeaudio.com/magazine/drum-synth-sound-design-kick-snare)
