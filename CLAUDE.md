# CLAUDE.md

Start here, then read:

1. **`HANDOFF.md`**: current project state, approved rules, and what is done or still open
   (in Czech, written for any developer). Read it first in every session, and update it when you
   finish or start a larger piece of work.
2. **`claude/`**: working notes for Claude (in English):
   - `claude/project.md`: project map, language rule, API, commands, pitfalls.
   - `claude/progress.md`: log of completed work (newest first). Add an entry after each session.

Quick rules (details in `claude/project.md`):
- **Code is in English** (identifiers, comments, file names, API, config keys). **Everything users
  see is in Czech** (UI, messages, READMEs, file formats users edit, such as container properties
  `typ`/`poznamka` and QGIS export columns).
- Tests: `python -m pytest` (Python version), `cd web && node --test tests/*.test.js` (web version).
- Do not put the user's e-mail in the User-Agent or anywhere else in the code.
- Do not pre-download or store tiles from tile.openstreetmap.org (OSM terms forbid it).
