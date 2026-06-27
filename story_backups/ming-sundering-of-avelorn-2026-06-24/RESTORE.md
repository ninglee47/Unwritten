# Story backup — "The Exile's Spear at the Edge of the World"

A full snapshot of a single playthrough, kept for future testing.

| | |
|---|---|
| **Backed up** | 2026-06-24 |
| **World** | The Sundering of Avelorn (`world-sundering-of-avelorn`) |
| **Story id** | `31e392c7-c64b-4e3e-8dd7-8262f4df91a1` |
| **Player** | Ming — Exiled Far-Eastern Spear Master |
| **Progress** | turn 92 · chapter 7 (beat 4/12) |
| **Scene** | Helvrath's Cross waystation — common room, deep night |
| **Contents** | 11 characters (with portraits), 6 illustrated chapters, 15 scene images, 32 ledger facts, 81 memories, 1 ebook export |

This folder mirrors the live `data/` layout, so restoring is a plain copy.

## Restore

From the project root (`openworld/`):

```bash
# (optional) snapshot whatever is currently in data/ first
[ -d data ] && mv data "data.before-restore.$(date +%s)"

# copy this backup's world + story into data/
mkdir -p data/worlds data/stories
cp -R "story_backups/ming-sundering-of-avelorn-2026-06-24/worlds/."   data/worlds/
cp -R "story_backups/ming-sundering-of-avelorn-2026-06-24/stories/." data/stories/

npm start   # then open http://localhost:3000 and click "Continue a story"
```

The story re-appears under **Continue a story** on the home screen.

## Notes

- The world (`data/worlds/world-sundering-of-avelorn/`) is required — the story references it by id.
- Restoring is **additive**: it drops this world/story alongside anything already in `data/`. It does
  not delete other stories. To restore *only* this one into a clean slate, clear `data/` first (the
  optional `mv` line above).
- `.png` files are the rendered portraits / chapter / scene images. `.json` files are the save state
  (story, characters, memories, ledger, transcript, chapters). `exports/` holds a generated ebook PDF.
- This snapshot was taken with the v0.3 build. Older builds will still load it (newer fields are
  optional), but features added after this date won't be reflected in the saved state until you play
  forward.
