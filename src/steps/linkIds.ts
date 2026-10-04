// backlog/linkIds: hardcover_id for backlog rows from their isbn. Port of link_hardcover_ids.py + manual_link.py.
// Only an isbn that points at exactly one Hardcover book is linked; an ambiguous or unknown isbn gets a paste field
// for a Hardcover URL or slug instead. The paste belongs to its row by construction, never matched back by title.

import type { ApplyResult, Change, Plan } from "../core/changes";
import { emptyResult } from "../core/changes";
import { hardcoverLink, parseHardcoverSlug } from "../core/idLinks";
import { serializeTable, setCell } from "../core/table";
import { ApplyContext, describeRow, findRow, HardcoverReads, loadBacklog, parseBacklog, paths, PlanContext, rowHardcoverId, RowKey, rowKey, Step } from "./context";

export interface LinkPayload {
	key: RowKey;
	/** Null until a pasted link is resolved */
	bookId: number | null;
	slug: string | null;
}

export async function planLink(ctx: PlanContext): Promise<Plan<LinkPayload>> {
	const table = await loadBacklog(ctx.vault, ctx.settings);
	const plan: Plan<LinkPayload> = { step: "backlog/linkIds", changes: [], notes: [] };
	let matched = 0;
	let ambiguous = 0;
	let noMatch = 0;
	let noIsbn = 0;
	for (const [i, row] of table.rows.entries()) {
		if (row.malformed) {
			// Its cells may be shifted; only worth a note if the line holds no Hardcover link at all
			if (!rowHardcoverId(row)) {
				plan.notes.push(`${describeRow(row)}: the row's cell count doesn't match the header (a stray "|"?), so it can't be linked. Fix the row by hand.`);
			}
			continue;
		}
		if ((row.cells["hardcover_id"] ?? "").trim()) {
			continue;
		}
		const isbn = (row.cells["isbn"] ?? "").trim();
		if (!isbn) {
			noIsbn++;
			continue;
		}
		const key = rowKey(row);
		const id = `link:${key.goodreadsId ?? `row${i}`}`;
		const match = await ctx.hardcover.lookupIsbn(isbn);
		if (match.book) {
			matched++;
			plan.changes.push({
				id,
				summary: `Link ${describeRow(row)} -> hardcover_id ${match.book.id}`,
				details: [`isbn ${isbn}`],
				warnings: [],
				writesHardcover: false,
				selected: true,
				ready: true,
				payload: { key, bookId: match.book.id, slug: match.book.slug },
			});
			continue;
		}
		if (match.count) {
			ambiguous++;
		} else {
			noMatch++;
		}
		plan.changes.push({
			id,
			summary: `${describeRow(row)}: ${match.count ? `isbn ${isbn} matches ${match.count} different Hardcover books` : `no Hardcover edition with isbn ${isbn}`}`,
			details: [],
			warnings: [],
			writesHardcover: false,
			selected: false,
			ready: false,
			input: { kind: "hardcoverLink", prompt: "Paste a Hardcover URL or slug to link it, or leave blank to skip", value: "" },
			payload: { key, bookId: null, slug: null },
		});
	}
	plan.notes.unshift(`Rows with an isbn and no hardcover_id: ${matched} matched, ${ambiguous} ambiguous, ${noMatch} no match; ${noIsbn} skipped (no isbn).`);
	return plan;
}

/**
 * Looks up the pasted URL or slug of a waiting change. Exactly one book makes the change ready (and ticks it);
 * blank, no book or several books leave it waiting. Returns what to show next to the field.
 */
export async function resolveLinkInput(hardcover: Pick<HardcoverReads, "booksBySlug">, change: Change<LinkPayload>): Promise<string> {
	change.payload.bookId = null;
	change.payload.slug = null;
	change.ready = false;
	change.selected = false;
	change.details = [];
	const pasted = change.input?.value.trim() ?? "";
	if (!pasted) {
		return "";
	}
	const slug = parseHardcoverSlug(pasted);
	const books = await hardcover.booksBySlug(slug);
	if (books.length !== 1) {
		return books.length ? `Several Hardcover books have the slug "${slug}". Check by hand.` : `No Hardcover book found for "${slug}".`;
	}
	const book = books[0];
	change.payload.bookId = book.id;
	change.payload.slug = slug;
	change.ready = true;
	change.selected = true;
	change.details = [`Found "${book.title}" (hardcover_id ${book.id})`];
	return change.details[0];
}

export async function applyLink(ctx: ApplyContext, changes: Change<LinkPayload>[]): Promise<ApplyResult> {
	const result = emptyResult();
	const ready = changes.filter((change) => change.payload.bookId !== null && change.payload.slug);
	if (!ready.length) {
		return result;
	}
	const path = paths(ctx.settings).backlog;
	await ctx.vault.process(path, (text) => {
		const table = parseBacklog(text, path);
		for (const change of ready) {
			const row = findRow(table, change.payload.key);
			if (!row || row.malformed) {
				result.skipped.push({ id: change.id, reason: row ? "the row's cell count doesn't match the header" : "row not found (changed since the plan)" });
			} else if ((row.cells["hardcover_id"] ?? "").trim()) {
				result.skipped.push({ id: change.id, reason: "hardcover_id was filled in meanwhile" });
			} else {
				setCell(table, row, "hardcover_id", hardcoverLink(change.payload.bookId, change.payload.slug));
				result.applied.push(change.id);
			}
		}
		return serializeTable(table);
	});
	return result;
}

export const linkIds: Step<LinkPayload> = {
	id: "backlog/linkIds",
	plan: planLink,
	apply: applyLink,
};
