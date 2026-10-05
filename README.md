# Book Sync for Obsidian

[![CI](https://github.com/Arcadia197/obsidian-book-sync/actions/workflows/ci.yaml/badge.svg)](https://github.com/Arcadia197/obsidian-book-sync/actions/workflows/ci.yaml)

Keeps a Goodreads to-read shelf, a reading backlog in Markdown, [Hardcover](https://hardcover.app) and one note per book in step, with a review of every change before it is written.

> **Personal first.** This plugin is built around one person's book notes: a fixed backlog table, a fixed note format and a label-to-list mapping file. It works for anyone who keeps the same layout (see [Vault layout](#vault-layout)), but field names and the note template aren't configurable yet. It isn't in the community plugin list; install it with BRAT.

## What it does

A sync runs in three parts, one step at a time:

| Part | Steps | Direction |
|------|-------|-----------|
| **Backlog** | Pull from Goodreads, link Hardcover ids, push to Hardcover | Goodreads to-read shelf → `Want to Read.md` → Hardcover "Want to Read" |
| **Labels** | Sync labels | Labels in your notes and backlog ⇄ Hardcover lists (additive only, nothing is ever removed) |
| **Archive** | Create notes, clean up the backlog, finished books | Books you started or finished on Hardcover become notes; finished ones get the read date, your rating and your review |

Every step first reads and shows what it would change. Nothing is written until you press **Apply**, and only the changes you left ticked are written. Changes to Hardcover start unticked.

- **Labels for new books** are suggested by OpenAI (optional), limited to labels you already use. Edit them as chips, or tell the AI in plain words what's off ("the second one is more grief than mystery").
- **No guessing:** an isbn that matches several Hardcover books is never linked automatically. Paste the right Hardcover link instead.
- **Left for you:** things a sync can't do (pick an edition on Hardcover, fill a note's `medium`, update Goodreads) go on a list on the start page. It's stored with the plugin's settings, so it's the same on every device your vault syncs to, and items tick themselves off once the plugin sees them done.
- **Add a book** that isn't on your Goodreads shelf from its Goodreads link.

Works on desktop and on phones (the review uses a compact layout with large tap targets there).

## Install

1. Install [BRAT](obsidian://show-plugin?id=obsidian42-brat) and add the repository `Arcadia197/obsidian-book-sync`.
2. Enable **Book Sync** in Settings → Community plugins.
3. In the plugin settings, set the paths (see below) and the keys. Each key has a **Test** button.

| Key | Where to get it | Needed for |
|-----|-----------------|------------|
| Hardcover API token | hardcover.app → Settings → API | Everything that reads or writes Hardcover |
| Goodreads RSS URL | The RSS link at the bottom of any of your Goodreads shelves; the plugin picks the shelf itself (to-read), so the part after `shelf=` doesn't matter and may be empty | Pulling the shelf (the URL contains a private key) |
| OpenAI API key | platform.openai.com | Label suggestions (optional) |

Keys are saved in the plugin's `data.json` inside your vault, so they sync to your other devices along with the vault. Don't share that file.

## Use

Open the **Book Sync** tab from the ribbon (library icon) or the command palette:

| Command | What it does |
|---------|--------------|
| Book Sync: Open | Start page: full sync, one part, Left for you, add a book |
| Book Sync: Full sync | Backlog, labels and archive, one step at a time |
| Book Sync: Sync backlog / labels / archive | One part only |
| Book Sync: Add to Want to Read | Start page with the Goodreads link field focused |

In a step, tap a card to tick or untick it. **Apply** writes the ticked changes; **Skip step** moves on without writing. **End sync** stops the run: steps you already applied stay applied, nothing else is written. Closing the tab does the same.

## Vault layout

All paths are relative to the **Books folder** set in the settings.

- **`Want to Read.md`**: one Markdown table with the columns `Title | Author | DateAdded | Genre | Labels | Notes | isbn | goodreads_id | hardcover_id`. Text above and below the table is kept as it is. Rows are sorted by `DateAdded`, newest first. Rows the plugin can't read (a stray `|`, no Goodreads id) are kept untouched.
- **`Hardcover Lists.md`**: a table `Label | hardcover_list` mapping each label to a Hardcover list. A row with a blank Label means "leave this list alone". Text below the table that explains your labels is passed to the AI with the label suggestions.
- **`Database/`**: one note per book, with frontmatter such as `title`, `author`, `dateRead`, `rating_10`, `labels`, `owned`, `goodreads_id`, `hardcover_id`. New notes follow the same template.

What wins on a conflict: Hardcover owns reading status, dates read and rating; your vault owns notes, labels and everything Hardcover doesn't model.

## Privacy

The plugin talks only to `api.hardcover.app`, `www.goodreads.com` (your shelf's RSS feed and single book pages) and, if you set a key, `api.openai.com` (titles, authors and your label list for suggestions). Nothing else leaves your device.

## Development

```bash
npm install
npm run build      # type-check + bundle to main.js
npm test           # unit tests (no Obsidian needed)
npm run test:e2e   # drives a real Obsidian on a throwaway vault against local fake servers
npm run dev        # watch build
```

`src/core/` and `src/api/` don't import `obsidian`, so they are unit-tested with Node's test runner. Every pipeline step has `plan()` (reads only, gets a Hardcover client without write access) and `apply()` (writes only the ticked changes). Releases: `npm run release` tags a version; the tag builds and publishes the GitHub release.

## License

[MIT](LICENSE)
