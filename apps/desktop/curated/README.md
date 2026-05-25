# Curated areas (bespoke themed artwork)

This is the **paid layer** of the Steam build: hand-made themed puzzle
areas, decoupled from the daily LLM-generated puzzles. Each area is one
folder here; the embedded server (`../src/server.js`) serves it in place
of a daily puzzle when a demo area's `puzzleDate` points at the folder.

## Authoring an area

1. **Pick an id.** Use a reserved ISO date *before* the daily archive
   start (`2026-03-17`) — e.g. `2026-01-01`. It parses as a date for the
   in-game label but never collides with real daily content, and the
   archive browser never reaches it.

2. **Make the folder** `curated/<id>/` and drop one image per mode,
   named after the puzzle category key:

   ```
   curated/2026-01-01/
     jigsaw.webp      # GAME_MODE_JIGSAW
     slider.webp      # GAME_MODE_SLIDING
     swap.webp        # GAME_MODE_SWAP
     polygram.webp    # GAME_MODE_POLYGRAM
     diamond.webp     # GAME_MODE_DIAMOND
     meta.json        # optional, see below
     *_thumb.webp     # optional; falls back to the full image
   ```

   `.webp` is preferred; `.jpg` / `.jpeg` / `.png` also work. A mode with
   no image is simply omitted (its slice won't appear).

3. **Optional `meta.json`** for the theme label / search tags:

   ```json
   { "title": "Classroom", "theme": "Sunlit classroom still life", "tags": ["classroom", "still life"] }
   ```

4. **Build the manifest:**

   ```
   node scripts/build-curated.mjs            # all areas
   node scripts/build-curated.mjs 2026-01-01 # just one
   ```

   This writes `puzzle.json` — shaped like a `/api/puzzles/<date>`
   response — which the server and web bundle consume unchanged.

5. **Point a demo area at it** in `../demo-config.json`: set that area's
   `"puzzleDate"` to the curated id (e.g. `"2026-01-01"`). Difficulty
   overrides in `demo-config.json` still apply on top.

## Notes

- Source images + `puzzle.json` are **committed** (unlike the gitignored
  `offline-pack/`) — they're the product.
- Curated content is never proxied to xefig.com; it ships in the build
  and always works offline.
- Run-saves key on the id, so two areas must not share an id.
