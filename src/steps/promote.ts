// archive/promote: books that moved to Currently Reading or Read on Hardcover get their Database/ note, and their
// backlog row goes. Port of promote_from_hardcover.py.
// - Every stored hardcover_id (rows and notes) is resolved through Hardcover's merges before matching
// - Cheap status query for all reading/read books first, the detailed query only for candidates (the full shape
//   for ~165 books timed out)
// - Books that never had a backlog row get a note too, with a Goodreads id suggested from the shelf that matches
//   their status by title + author: a guess, so these start unticked and the id stays editable
// - An existing note file is never overwritten

import { noteFieldsTodo, offShelfTodo } from "../core/todos";
import type { ApplyResult, Change, Plan } from "../core/changes";
import { emptyResult } from "../core/changes";
import { parseGoodreadsId } from "../core/idLinks";
import { BacklogInfo, buildNote, BuiltNote, chooseAuthor, chooseTitle } from "../core/noteBuilder";
import type { HardcoverUserBook } from "../core/hardcoverTypes";
import { titleKey } from "../core/titleMatch";
import type { ShelfEntry } from "../api/goodreads";
import { ApplyContext, describeRow, loadBacklog, loadNotes, NoteFile, paths, PlanContext, rowGoodreadsId, rowHardcoverId, RowKey, rowKey, Step } from "./context";
import { applyMerge, mergeChange, MergePayload } from "./merges";
import { GOODREADS_REMINDER, notesWarning, removeRows } from "./reconcile";

const STATUS_NAMES: Record<number, string> = { 2: "Currently Reading", 3: "Read" };

export type PromotePayload =
	| {
			kind: "create";
			entry: HardcoverUserBook;
			backlog: BacklogInfo;
			/** The backlog row to remove once the note exists; null for a book that never had one */
			row: RowKey | null;
	  }
	| { kind: "removeRow"; key: RowKey; name: string }
	| MergePayload;

function seriesWarning(built: BuiltNote): string[] {
	const s = built.series;
	return s ? [`Series guessed from Hardcover, needs review: ${s.name} #${s.position ?? "?"}/${s.total ?? "?"}`] : [];
}

function editionWarning(built: BuiltNote, entry: HardcoverUserBook): string[] {
	return built.noEdition
		? [
				`IMPORTANT: no edition picked for this book on Hardcover, so title, isbn, cover, pages and language came from the book's defaults, not your copy. Pick your edition on Hardcover, then check the note against it (https://hardcover.app/books/${entry.book.slug}).`,
			]
		: [];
}

function noteName(built: BuiltNote): string {
	return built.filename.replace(/\.md$/, "");
}

export async function planPromote(ctx: PlanContext): Promise<Plan<PromotePayload>> {
	const statuses = await ctx.hardcover.readingStatuses();
	const statusById = new Map(statuses.map((s) => [String(s.book_id), s.status_id]));
	const table = await loadBacklog(ctx.vault, ctx.settings);
	const notes = await loadNotes(ctx.vault, ctx.settings);
	const plan: Plan<PromotePayload> = { step: "archive/promote", changes: [], notes: [] };

	const noteIds = notes.filter((n) => n.note.hardcoverId).map((n) => n.note.hardcoverId as string);
	const rowIds = table.rows.map(rowHardcoverId).filter((id): id is string => !!id);
	const merges = await ctx.hardcover.resolveMerges([...rowIds, ...noteIds]);
	const canonical = (id: string) => (merges.has(id) ? String(merges.get(id)!.id) : id);

	const noteByCanonical = new Map<string, NoteFile>();
	for (const file of notes) {
		const id = file.note.hardcoverId;
		if (id) {
			noteByCanonical.set(canonical(id), file);
			const merged = merges.get(id);
			if (merged) {
				plan.changes.push(mergeChange(file.note, merged));
			}
		}
	}
	const rowCanonical = new Set(rowIds.map(canonical));

	const candidates: { row: (typeof table.rows)[number]; id: string }[] = [];
	const noHardcoverId: string[] = [];
	for (const row of table.rows) {
		const raw = rowHardcoverId(row);
		if (!raw) {
			noHardcoverId.push(describeRow(row));
			continue;
		}
		const id = canonical(raw);
		if (!statusById.has(id)) {
			continue;
		}
		const existing = noteByCanonical.get(id);
		if (existing) {
			plan.changes.push({
				id: `archived:${rowGoodreadsId(row) ?? id}`,
				summary: `Remove ${describeRow(row)} from the backlog: it already has a Database/ note (${existing.note.path.split("/").pop()})`,
				details: [],
				warnings: notesWarning(row.cells["Notes"]),
				writesHardcover: false,
				selected: true,
				ready: true,
				file: existing.note.path,
				payload: { kind: "removeRow", key: rowKey(row), name: describeRow(row) },
			});
			continue;
		}
		candidates.push({ row, id });
	}
	const uncoveredIds = [...statusById.keys()].filter((id) => !noteByCanonical.has(id) && !rowCanonical.has(id));

	const details = await ctx.hardcover.userBookDetails([...candidates.map((c) => c.id), ...uncoveredIds]);
	const detailById = new Map(details.map((entry) => [String(entry.book_id), entry]));

	plan.notes.push(`${table.rows.length} row(s) in the backlog, ${noHardcoverId.length} without a hardcover_id (can't check).`);
	if (noHardcoverId.length) {
		plan.notes.push("No hardcover_id yet, run the link step first if these have an isbn:", ...noHardcoverId.map((d) => `  - ${d}`));
	}

	const database = paths(ctx.settings).database;
	for (const { row, id } of candidates) {
		const entry = detailById.get(id);
		if (!entry) {
			continue;
		}
		const backlog: BacklogInfo = row.malformed
			? { goodreadsId: rowGoodreadsId(row) ?? "", genre: "", labels: "" }
			: { goodreadsId: rowGoodreadsId(row) ?? "", genre: row.cells["Genre"] ?? "", labels: row.cells["Labels"] ?? "" };
		const built = buildNote(entry, backlog, ctx.settings.ownerName);
		if ((await ctx.vault.read(`${database}/${built.filename}`)) !== null) {
			plan.notes.push(`${built.filename} already exists: not overwritten, ${describeRow(row)} stays in the backlog.`);
			continue;
		}
		plan.changes.push({
			id: `promote:${id}`,
			summary: `Create note ${noteName(built)} (${STATUS_NAMES[entry.status_id] ?? entry.status_id}) and remove its backlog row`,
			details: [`Still needs by hand: ${built.stillNeeded.join(", ")}`],
			warnings: [
				...editionWarning(built, entry),
				...notesWarning(row.cells["Notes"]),
				...(row.malformed ? ['The backlog row\'s cell count doesn\'t match the header (a stray "|"?): Genre and Labels not carried over'] : []),
				...seriesWarning(built),
			],
			writesHardcover: false,
			selected: true,
			ready: true,
			payload: { kind: "create", entry, backlog, row: rowKey(row) },
		});
	}

	const shelves = new Map<string, ShelfEntry[] | Error>();
	for (const id of uncoveredIds) {
		const entry = detailById.get(id);
		if (!entry) {
			continue;
		}
		const shelf = entry.status_id === 2 ? "currently-reading" : "read";
		const suggestion = await suggestGoodreadsId(ctx, shelves, shelf, chooseTitle(entry), chooseAuthor(entry));
		const backlog: BacklogInfo = { goodreadsId: suggestion.id ?? "", genre: "", labels: "" };
		const built = buildNote(entry, backlog, ctx.settings.ownerName);
		if ((await ctx.vault.read(`${database}/${built.filename}`)) !== null) {
			plan.notes.push(`${built.filename} already exists: not overwritten.`);
			continue;
		}
		plan.changes.push({
			id: `new:${id}`,
			summary: `Create note ${noteName(built)} (${STATUS_NAMES[entry.status_id] ?? entry.status_id}): on Hardcover, but never in the backlog`,
			details: [`Still needs by hand: ${built.stillNeeded.join(", ")}`],
			warnings: [...editionWarning(built, entry), suggestion.warning, ...seriesWarning(built)],
			writesHardcover: false,
			selected: false,
			ready: true,
			input: { kind: "goodreadsId", prompt: "Goodreads URL or id (blank: fill in later)", value: suggestion.id ?? "" },
			payload: { kind: "create", entry, backlog, row: null },
		});
	}

	if (!plan.changes.length) {
		plan.notes.push("No promotions found, nothing to do.");
	}
	return plan;
}

/** A Goodreads id from the shelf by normalized title + author, only when exactly one book matches. Never applied unseen */
async function suggestGoodreadsId(
	ctx: PlanContext,
	cache: Map<string, ShelfEntry[] | Error>,
	shelf: string,
	title: string,
	author: string,
): Promise<{ id: string | null; warning: string }> {
	if (!cache.has(shelf)) {
		try {
			cache.set(shelf, ctx.settings.goodreadsRssUrl ? await ctx.goodreads.fetchShelf(ctx.settings.goodreadsRssUrl, shelf) : new Error("no Goodreads RSS URL set"));
		} catch (err) {
			cache.set(shelf, err as Error);
		}
	}
	const entries = cache.get(shelf)!;
	if (entries instanceof Error) {
		return { id: null, warning: `Couldn't read your Goodreads "${shelf}" shelf (${entries.message}): paste the goodreads_id by hand, or leave it for later` };
	}
	const key = titleKey(title, author);
	const matches = entries.filter((e) => titleKey(e.title, e.author) === key);
	return matches.length === 1
		? { id: matches[0].goodreadsId, warning: `goodreads_id ${matches[0].goodreadsId} is a title + author match on your Goodreads "${shelf}" shelf: check it before ticking` }
		: { id: null, warning: `No confident match on your Goodreads "${shelf}" shelf: paste the goodreads_id, or leave it for later` };
}

export async function applyPromote(ctx: ApplyContext, changes: Change<PromotePayload>[]): Promise<ApplyResult> {
	const result = emptyResult();
	const database = paths(ctx.settings).database;
	/** Rows to remove once their notes exist; `reminder`: the Goodreads id and name for the shelf reminder */
	const removals: { id: string; key: RowKey; reminder?: { goodreadsId: string; name: string } }[] = [];
	for (const change of changes) {
		const payload = change.payload;
		if (payload.kind === "create") {
			let backlog = payload.backlog;
			if (change.input) {
				const typed = change.input.value.trim();
				const id = typed ? parseGoodreadsId(typed) : "";
				if (id === null) {
					result.messages.push(`Couldn't read a Goodreads id from "${typed}": goodreads_id left blank.`);
				}
				backlog = { ...backlog, goodreadsId: id ?? "" };
			}
			const built = buildNote(payload.entry, backlog, ctx.settings.ownerName);
			const path = `${database}/${built.filename}`;
			if ((await ctx.vault.read(path)) !== null) {
				result.skipped.push({ id: change.id, reason: `${built.filename} already exists, not overwritten` });
				continue;
			}
			try {
				await ctx.vault.create(path, built.text);
			} catch (err) {
				// One unwritable note (a filename the device refuses) doesn't lose the rest of the run's results
				result.skipped.push({ id: change.id, reason: `couldn't create ${built.filename}: ${(err as Error).message}` });
				continue;
			}
			result.applied.push(change.id);
			result.messages.push(`Created ${built.filename}. Still needs by hand: ${built.stillNeeded.join(", ")}`);
			const name = built.filename.replace(/\.md$/, "");
			const todos = (result.todos ??= []);
			todos.push(...noteFieldsTodo(path, name, built.stillNeeded, payload.entry.book.slug));
			if (built.noEdition) {
				// No check: picking the edition is only half of it, the note still shows the default edition's data
				todos.push({
					key: `edition:${payload.entry.book_id}`,
					text: `${name}: pick your edition on Hardcover, then check the note against it (title, isbn, cover, pages, language)`,
					url: `https://hardcover.app/books/${payload.entry.book.slug}`,
					file: path,
				});
			}
			if (payload.row) {
				removals.push({ id: change.id, key: payload.row, reminder: backlog.goodreadsId ? { goodreadsId: backlog.goodreadsId, name } : undefined });
			}
		} else if (payload.kind === "merge") {
			const reason = await applyMerge(ctx.vault, payload);
			if (reason) {
				result.skipped.push({ id: change.id, reason });
			} else {
				result.applied.push(change.id);
			}
		} else {
			removals.push({ id: change.id, key: payload.key });
		}
	}
	const found = await removeRows(ctx.vault, ctx.settings, removals.map((r) => r.key));
	removals.forEach((removal, i) => {
		const change = changes.find((c) => c.id === removal.id)!;
		if (change.payload.kind === "removeRow") {
			if (found[i]) {
				result.applied.push(removal.id);
				if (removal.key.goodreadsId) {
					(result.todos ??= []).push(offShelfTodo(removal.key.goodreadsId, change.payload.name));
				}
			} else {
				result.skipped.push({ id: removal.id, reason: "row not found (already removed or changed)" });
			}
		} else if (!found[i]) {
			result.messages.push(`The backlog row for ${change.id} was already gone.`);
		} else if (removal.reminder) {
			(result.todos ??= []).push(offShelfTodo(removal.reminder.goodreadsId, removal.reminder.name));
		}
	});
	if (found.some(Boolean)) {
		result.messages.push(GOODREADS_REMINDER);
	}
	return result;
}

export const promote: Step<PromotePayload> = {
	id: "archive/promote",
	plan: planPromote,
	apply: applyPromote,
};
