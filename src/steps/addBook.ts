// backlog/addBook: one Goodreads book as a new row in Want to Read.md, for a book that isn't on the Goodreads shelf.
// Port of add_to_want_to_read.py: the book page gives Title, Author and isbn (isbn_10); DateAdded is today (the day
// it was added here, not a Goodreads date). Refused for a book that already has a row or a Database/ note.
// Differs from the Python: Labels get an AI suggestion like new rows from the shelf (the Python leaves them blank,
// which the labels sync then flags), and the row is written by the pull step's apply, so it is sorted and checked
// for duplicates the same way. "Already archived" reads a note's goodreads_id field (the Python takes the first
// Goodreads link anywhere in the note); apply re-checks for a duplicate row, not for a note created since the plan.

import type { Change, Plan } from "../core/changes";
import { parseGoodreadsId } from "../core/idLinks";
import { labelVocabulary } from "../api/openai";
import { describeRow, loadBacklog, loadNotes, PlanContext, rowGoodreadsId, Step } from "./context";
import { applyPull, labelsInput, PullPayload, suggestLabels } from "./pullGoodreads";

/** Today as YYYY-MM-DD in local time, like Python's date.today() */
export function localDate(now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * What adding the book would change: one ticked change, or none with the reason in the notes. Reads only.
 * Throws for input that holds no Goodreads id, and when the book page can't be read.
 */
export async function planAddBook(ctx: PlanContext, idOrUrl: string, today = localDate()): Promise<Plan<PullPayload>> {
	const goodreadsId = parseGoodreadsId(idOrUrl);
	if (!goodreadsId) {
		throw new Error(`No Goodreads book id in "${idOrUrl.trim()}". Paste a link like goodreads.com/book/show/12345 or the number.`);
	}
	const plan: Plan<PullPayload> = { step: "backlog/addBook", changes: [], notes: [] };
	const notes = await loadNotes(ctx.vault, ctx.settings);
	const archived = notes.find((n) => n.note.goodreadsId === goodreadsId);
	if (archived) {
		plan.notes.push(`Already archived: ${archived.note.path.split("/").pop()} has goodreads_id ${goodreadsId}. Not added.`);
		return plan;
	}
	const table = await loadBacklog(ctx.vault, ctx.settings);
	const row = table.rows.find((r) => rowGoodreadsId(r) === goodreadsId);
	if (row) {
		plan.notes.push(`Already in Want to Read: ${describeRow(row)}. Not added again.`);
		return plan;
	}
	const book = await ctx.goodreads.fetchBook(goodreadsId);
	const vocabulary = labelVocabulary(notes.map((n) => n.note));
	const change: Change<PullPayload> = {
		id: `add:${goodreadsId}`,
		summary: `Add ${book.title} (${book.author})`,
		details: [`DateAdded ${today} (today), isbn ${book.isbn || "(none)"}`],
		warnings: [],
		writesHardcover: false,
		selected: true,
		ready: true,
		input: labelsInput("", [...vocabulary.keys()].sort()),
		payload: { kind: "add", entry: { ...book, goodreadsId, dateAdded: today }, vocabulary: [...vocabulary.keys()].sort() },
	};
	plan.changes.push(change);
	await suggestLabels(ctx, [change], vocabulary, plan.notes);
	if (book.isbn) {
		plan.notes.push("The next backlog sync links its hardcover_id from the isbn.");
	}
	return plan;
}

export const addBook: Step<PullPayload> = {
	id: "backlog/addBook",
	plan: () => Promise.reject(new Error("Adding a book needs its Goodreads link: use planAddBook")),
	apply: applyPull,
};
