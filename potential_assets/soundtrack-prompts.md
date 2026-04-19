# Xefig Soundtrack — Lyria 3 Pro Prompts

Twelve-track cohesive ambient album (~24 min total) for background use during puzzle play. Generated via Google Lyria 3 Pro (max 3 min per track, ~$0.08 each).

## Design principles

- **Instrumental only.** Vocals wreck the "listen to a podcast while playing" use case.
- **No percussion.** Percussion implies passing time and forward motion, fighting the "take your time" vibe.
- **No builds, drops, or climaxes.** These are attention hooks — background music must never demand attention.
- **Locked instrument palette across all 12 tracks.** Soft felt piano, warm analog pads, subtle strings, occasional glockenspiel. Variation happens in mood, key, tempo, and which instrument is foregrounded — never by introducing new instruments.
- **Stay in major / Lydian / Dorian modes.** Minor keys read as heavy/melancholy for background use.
- **Tempo range 60–85 BPM.** Spread evenly across the album.
- **References:** Brian Eno's *Music for Airports*, Stardew Valley's cozy interior themes. (Possible third reference: Hiroshi Yoshimura's *Music for Nine Post Cards* — unconfirmed.)

## Master prompt (prepend to every track)

> *Instrumental only, no vocals, no lyrics, no spoken word, no percussion, no drums. Gentle ambient background music for a relaxing puzzle game, in the spirit of Brian Eno's "Music for Airports" and the cozy interior themes of Stardew Valley. Soft felt piano, warm analog pads, subtle strings, occasional glockenspiel. Continuous texture, no clear beginning or end, no builds or dynamic swells, no climactic moments. The music should imply "there is no rush, take your time" — unhurried phrasing, long-held notes, patient harmonic motion. Calm and unobtrusive, meant to fade into the background.*

## Track variation tails

Append one of these to the master prompt per generation.

1. **Evening homecoming** — warm and welcoming, G major, 74 BPM. Piano-forward with soft pad bed.
2. **Floating / weightless** — pure *Music for Airports* mode, C Lydian, 62 BPM. Pad-forward, rare isolated piano notes, no rhythm.
3. **Fireside** — cozy and close, D major, 78 BPM. Felt piano + quiet sustained strings.
4. **Morning window** — airy and spacious, F Lydian, 66 BPM. Pad-forward with distant piano echoes.
5. **Gentle wandering** — light forward motion without urgency, G major, 82 BPM. Soft piano motif drifting over a slow-rocking pad, Stardew-esque.
6. **Wool sweater** — warm-melancholy, A Dorian, 70 BPM. Soft cello foregrounded, piano accompanies.
7. **Village lights** — twinkling and nostalgic, E major, 76 BPM. Glockenspiel + sparse piano, Stardew interior feel.
8. **Snow globe** — suspended stillness, B♭ major, 60 BPM. Sustained pads only, no rhythm, occasional piano.
9. **Afternoon tea** — light and present, D major, 80 BPM. Piano arpeggios over warm pads.
10. **Old photograph** — nostalgic warmth, F major, 72 BPM. Piano + cello intertwined, sepia mood.
11. **Dusk** — dreamy and suspended, E Lydian, 64 BPM. Pads + glockenspiel twinkles, no piano melody.
12. **Last embers** — quiet and settling, C major, 68 BPM. Sparse felt piano, fading pad wash, the album's exhale.

## Recommended playback sequence

Sequenced so no two consecutive tracks share a key or lead instrument:

`1 → 4 → 6 → 9 → 11 → 3 → 7 → 2 → 10 → 5 → 8 → 12`

## Generation workflow

- Generate two or three takes per prompt if credits allow — Lyria output varies, keep the best.
- After generating, listen for anything that drifts into song-shape (clear verse/chorus, climactic build, a resolving cadence at the end). Reject and regenerate — those break the background contract.
- Re-encode from Lyria's native output to 96 kbps VBR MP3 (or 80 kbps Opus) for delivery. Anything above that is wasted bytes for ambient looping background music.

## Encoding targets

- **MP3:** 96 kbps VBR (LAME `-V 6`). ~1.9 MB per 3-min track, ~23 MB for the full album.
- **Opus (optional):** 80 kbps. ~1.5 MB per track, ~18 MB total. Supported in all modern browsers (including Safari 17+).
- Ship files from `apps/web/public/music/` — lazy-fetched when the user enables music, not bundled into the main JS.
