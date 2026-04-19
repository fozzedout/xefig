# Background Music Feature — Implementation Plan

**Status:** Not started. Design phase complete. Ready to code.
**Resume on:** Different computer. Everything needed is in this repo.

## Feature goal

Opt-in background music toggle in the "More" menu of the launcher. Off by default. Persisted choice. Auto-pauses on tab hide / window blur. Lazy-loaded (no cost to users who never enable it).

## Design decisions (all confirmed with user)

- **Location:** fourth `.more-card` in the More slice, alongside Continue / Archive / Settings.
- **Default:** off. Persisted in `localStorage` under `xefig:music-enabled:v1`.
- **On reload with preference=on:** music auto-resumes at the *next user gesture* (browser autoplay policies block silent resume). Visual toggle state reflects preference immediately.
- **Auto-pause:** on `visibilitychange` (hidden) and window `blur`. Auto-resume on `focus` / visible *if* preference is on.
- **Delivery:** mp3, served from `apps/web/public/music/`. Lazy-fetched only when user toggles on. Not imported into JS bundle.
- **Volume:** fixed at ~0.35 for v1. Volume slider is a later polish item.
- **Format:** ship as mp3 (existing file is 192 kbps CBR, 2:36, 3.7 MB). Plan to replace with ~12-track album later per `soundtrack-prompts.md`, re-encoded to 96 kbps VBR (~1.9 MB/track).

## Asset

- Shipped location: `apps/web/public/music/coloring-book-cues.mp3` (already in place)
- Later: additional AI-generated tracks via Lyria 3 Pro, prompts in `potential_assets/soundtrack-prompts.md`.

## Code changes

All in `apps/web/src/main.js` unless noted.

### 1. localStorage key + accessors

Near line 57 (alongside `BOARD_COLOR_KEY`):

```js
const MUSIC_ENABLED_KEY = 'xefig:music-enabled:v1'
```

Near line 94 (alongside `getGlobalBoardColorIndex` / `setGlobalBoardColorIndex`):

```js
function getMusicEnabled() {
  return localStorage.getItem(MUSIC_ENABLED_KEY) === '1'
}
function setMusicEnabled(enabled) {
  localStorage.setItem(MUSIC_ENABLED_KEY, enabled ? '1' : '0')
}
```

### 2. Music controller (lazy `<Audio>` singleton)

Module-level, near the other singletons (~line 160, where `puzzle`, `currentRun` etc. live):

```js
let musicAudio = null
let musicShouldPlay = false

function ensureMusicAudio() {
  if (musicAudio) return musicAudio
  musicAudio = new Audio('/music/coloring-book-cues.mp3')
  musicAudio.loop = true
  musicAudio.volume = 0.35
  return musicAudio
}

function startMusic() {
  musicShouldPlay = true
  ensureMusicAudio().play().catch(() => {
    // Autoplay blocked. Will retry on next gesture.
  })
}

function stopMusic() {
  musicShouldPlay = false
  if (musicAudio) musicAudio.pause()
}

function pauseMusicTemporary() {
  if (musicAudio && !musicAudio.paused) musicAudio.pause()
}

function resumeMusicIfEnabled() {
  if (!musicShouldPlay) return
  ensureMusicAudio().play().catch(() => {})
}
```

### 3. More menu toggle card UI

In `renderSlices()` around line 991. Insert new `.more-card` between Archive (line 979) and Settings (line 991):

```js
`<button class="more-card" data-action="toggle-music">
  <div class="more-card-img">
    <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.2">
      <path d="M26 44V14l20-4v30" stroke-width="2" stroke-linejoin="round"/>
      <ellipse cx="22" cy="44" rx="6" ry="4"/>
      <ellipse cx="42" cy="40" rx="6" ry="4"/>
    </svg>
  </div>
  <span class="more-card-label">Music: ${getMusicEnabled() ? 'On' : 'Off'}</span>
</button>`
```

(Placeholder SVG — swap for something nicer if inspired. For a muted/off state indicator, consider a diagonal slash overlay when disabled, but the text label already communicates state.)

### 4. Click handler

In the `.more-card` click listener at line ~1110–1136. Add branch before the `data-page` switch:

```js
if (btn.dataset.action === 'toggle-music') {
  const nowEnabled = !getMusicEnabled()
  setMusicEnabled(nowEnabled)
  if (nowEnabled) startMusic()
  else stopMusic()
  const label = btn.querySelector('.more-card-label')
  if (label) label.textContent = `Music: ${nowEnabled ? 'On' : 'Off'}`
  return
}
```

### 5. Global visibility / focus listeners

Near the top level of the module (NOT inside `bindGameActivity()` at line ~555, which is game-only and gets unbound on game exit). Music spans launcher + game, so these must be always-on.

```js
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseMusicTemporary()
  else resumeMusicIfEnabled()
})
window.addEventListener('blur', pauseMusicTemporary)
window.addEventListener('focus', resumeMusicIfEnabled)
```

### 6. First-gesture auto-resume when preference is on

Near app boot, after `playerGuid` is set (~line 164):

```js
if (getMusicEnabled()) {
  musicShouldPlay = true
  const onFirstGesture = () => {
    ensureMusicAudio().play().catch(() => {})
    document.removeEventListener('pointerdown', onFirstGesture)
    document.removeEventListener('keydown', onFirstGesture)
  }
  document.addEventListener('pointerdown', onFirstGesture, { once: true })
  document.addEventListener('keydown', onFirstGesture, { once: true })
}
```

### 7. Move the audio file

✅ **Done.** File already at `apps/web/public/music/coloring-book-cues.mp3`.

## Testing checklist

- [ ] Cold load, music off (default): no audio element created, no network fetch for mp3
- [ ] Click Music card → label flips to "On", audio starts playing
- [ ] Click again → pauses, label reverts to "Off"
- [ ] Refresh with preference=on → no audio fires until first click/keypress (browser block), then resumes
- [ ] Tab away → music pauses; tab back → music resumes (if on)
- [ ] Alt-tab / window blur → music pauses; refocus → resumes (if on)
- [ ] Music persists across launcher ↔ game ↔ settings page navigation (single `<audio>` singleton, no restart)
- [ ] Bundle size: confirm main JS bundle did NOT grow — mp3 is in `public/`, not imported
- [ ] Existing jigsaw piece-snap sound (`apps/web/src/components/jigsaw-puzzle.js:1388-1422`) still plays correctly alongside music

## Known polish items deferred past v1

- Volume slider (add to Settings page at `main.js:2770`)
- Expanded album (12 tracks) with shuffle + cross-fade between tracks
- Visual "muted" state for the music card icon when off (currently only label communicates state)
- Consider ducking music during puzzle-complete sound / other UX sounds if clashing in practice
- Consider separate sync logic: should music preference sync across devices via `sync.js`? Probably yes — match the pattern used by `BOARD_COLOR_KEY`. Check whether `markSettingsDirty()` should be called on toggle.

## Key files (for fast re-orientation)

- `apps/web/src/main.js:57` — localStorage keys
- `apps/web/src/main.js:86-94` — getter/setter pattern (mirror this)
- `apps/web/src/main.js:160` — module-level singletons
- `apps/web/src/main.js:164` — boot sequence (where first-gesture hookup goes)
- `apps/web/src/main.js:555-589` — existing game-only visibility handlers (do NOT add music there)
- `apps/web/src/main.js:961-1000` — More slice rendering (toggle card goes here)
- `apps/web/src/main.js:1110-1136` — More card click handler (toggle branch goes here)
- `apps/web/src/main.js:2770` — Settings page (future volume slider home)
- `apps/web/src/components/jigsaw-puzzle.js:1388-1422` — existing WebAudio sound code (for reference, don't touch)
- `apps/web/public/` — static asset dir where mp3 will live
- `apps/web/public/music/coloring-book-cues.mp3` — initial soundtrack file (already in ship location)
- `potential_assets/soundtrack-prompts.md` — later album generation plan

## Design conversation context (why these choices)

- User's game is designed specifically so users can listen to podcasts / audiobooks while playing ("easy listening to other things while doing something non-logic thinking"). That's why the default is off and why auto-pause on blur matters — music must never fight an external audio app.
- We considered: single toggle (chosen), first-launch prompt, per-activity default, auto-ducking. Auto-pause on blur was the one non-toggle choice explicitly confirmed.
- We considered asset format trade-offs. Kept current mp3 as-is; will re-encode future tracks to 96 kbps VBR when the full album is generated.
- For the eventual album: user is generating tracks via Google Lyria 3 Pro at $0.08/track, up to 3 min each. Prompts are in `soundtrack-prompts.md`. Plan is a cohesive-album of 12 tracks (~24 min) in an Eno / Stardew Valley aesthetic, instrumental-only, no percussion, no builds.
