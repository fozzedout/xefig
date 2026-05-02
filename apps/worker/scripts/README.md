# Worker scripts

Local one-off utilities. They run on your machine, not in the worker.

## `migrate-images-to-webp`

Converts every existing JPEG puzzle image in R2 to WebP and updates
the D1 puzzle records to point at the new files. Idempotent — safe to
re-run; already-converted dates are skipped.

Why local: the conversion is CPU-bound (sharp uses libvips natively)
and processes a few hundred files at once. Doing this in a worker
would hit CPU/runtime limits; doing it locally with sharp finishes
in a few minutes for a year of puzzles.

### Setup

1. **R2 access keys** — Cloudflare dashboard → R2 → "Manage R2 API
   Tokens" → create one with **Object Read & Write** scoped to the
   `assets` bucket.
2. **Wrangler** — make sure you're logged in (`wrangler whoami`).
   The script uses wrangler for D1 updates so it inherits your shell
   auth there.
3. **Copy `.env.migrate.example` to `.env.migrate`** and fill in the
   three R2 values.
4. `npm install` in this directory.

### Run

```sh
# Preview what would change without writing anything:
DRY_RUN=true npm run migrate-webp

# Actually convert + update DB (keeps the old .jpg files):
npm run migrate-webp

# Once you're happy, remove the legacy .jpg files:
DELETE_JPGS=true npm run migrate-webp
```

### What it does

For every `puzzles/<date>/<category>.jpg` and `_thumb.jpg` in R2:

1. Downloads the JPEG.
2. Re-encodes as WebP at q=78 with `sharp`.
3. Uploads to `puzzles/<date>/<category>.webp` (and `_thumb.webp`).
4. Updates the matching D1 `puzzles.categories` row to point the
   `imageKey`, `imageUrl`, `fileName`, `contentType`, `thumbnailKey`,
   and `thumbnailUrl` at the new paths.

Old `.jpg` files are left in place by default so a rollback is just
a code change. Pass `DELETE_JPGS=true` to remove them once you've
verified the new files load on production.
