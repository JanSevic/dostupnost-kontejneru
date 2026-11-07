# CLAUDE.md

Start here, then read the working notes in **`claude/`** (in English):
- `claude/project.md`: approved rules, project map, language rule, API, commands, pitfalls.
  Read it first in every session and keep it up to date.
- `claude/progress.md`: log of completed work (newest first). Add an entry after each session.

User-facing documentation (Czech): `README.md` (overview) and `web/README.md` (how to use and deploy).

Quick rules (details in `claude/project.md`):
- The project is **only the web app in `web/`**. The Python version was removed at the user's request.
- **Code is in English** (identifiers, comments, file names, API, config keys, commit messages).
  **Everything users see is in Czech** (UI, messages, READMEs, file formats users edit, such as
  container properties `typ`/`poznamka` and QGIS export columns).
- Tests: `cd web && node --test tests/*.test.js`.
- Do not put the user's e-mail in the User-Agent or anywhere else in the code.
- Do not pre-download or store tiles from tile.openstreetmap.org (OSM terms forbid it).
