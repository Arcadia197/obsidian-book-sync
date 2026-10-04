// backlog/push: linked backlog rows that aren't on Hardcover at all yet are added as Want to Read (status 1). Port of
// push_want_to_read_to_hardcover.py.
// - A book with any status on Hardcover is left alone: Hardcover owns status
// - A row whose title + author matches a book tracked under another id is reported, not pushed (Hardcover sometimes
//   has two book entities for one real book: a wrong id is worse than a missing one)
// - Unlike the Python, stored ids are resolved through Hardcover's merges first; the labels step offers the on-file fix
// - Hardcover writes start unticked. apply() asks Hardcover again right before writing, so a second apply or a retry
//   after an interrupted run never adds a book twice
// - insert_user_book sets no edition: after pushing, every book gets a link to pick the edition by hand

import type { ApplyResult, Change, Plan } from "../core/changes";
import { emptyResult } from "../core/changes";
import { extractHardcoverSlug, hardcoverBookUrl } from "../core/idLinks";
import { primaryAuthorNames } from "../core/noteBuilder";
import { titleKey } from "../core/titleMatch";
import { describeRow, loadBacklog, PlanContext, rowHardcoverId, Step, WritingApplyContext } from "./context";

export interface PushPayload {
	/** Canonical Hardcover book id */
	bookId: number;
	/** The id in the row; differs from bookId after a merge. Either one on Hardcover means the book is there */
	storedId: number;
	/** The row's DateAdded, passed on as Hardcover's date_added; "" when blank */
	dateAdded: string;
	/** For the edition reminder's link */
	slug: string | null;
	name: string;
}

const STATUS_NAMES: Record<number, string> = { 1: "Want to Read", 2: "Currently Reading", 3: "Read", 4: "Paused", 5: "DNF", 6: "Ignored" };

export async function planPush(ctx: PlanContext): Promise<Plan<PushPayload>> {
	const table = await loadBacklog(ctx.vault, ctx.settings);
	const plan: Plan<PushPayload> = { step: "backlog/push", changes: [], notes: [] };
	const tracked = await ctx.hardcover.trackedBooks();
	const statusById = new Map(tracked.map((t) => [String(t.book_id), t.status_id]));
	const idsByTitle = new Map<string, string[]>();
	for (const t of tracked) {
		const key = titleKey(t.book.title, primaryAuthorNames(t.book.contributions));
		idsByTitle.set(key, [...(idsByTitle.get(key) ?? []), String(t.book_id)]);
	}

	const merges = await ctx.hardcover.resolveMerges(table.rows.map(rowHardcoverId).filter((id): id is string => !!id));
	const noId: string[] = [];
	const malformed: string[] = [];
	const duplicates: string[] = [];
	const stale: string[] = [];
	let alreadyTracked = 0;
	const planned = new Set<string>();
	for (const row of table.rows) {
		const storedId = rowHardcoverId(row);
		if (!storedId) {
			noId.push(`  - ${describeRow(row)}`);
			continue;
		}
		if (row.malformed) {
			malformed.push(`  - ${row.original}`);
			continue;
		}
		const merged = merges.get(storedId);
		const id = merged ? String(merged.id) : storedId;
		if (merged) {
			stale.push(`  - ${describeRow(row)}: ${storedId} -> ${id} (${merged.slug})`);
		}
		// The shelf entry may still point at the merged-away book
		if (statusById.has(id) || statusById.has(storedId)) {
			alreadyTracked++;
			continue;
		}
		const others = (idsByTitle.get(titleKey(row.cells["Title"] ?? "", row.cells["Author"])) ?? []).filter((other) => other !== id);
		if (others.length) {
			const statuses = others.map((other) => `${other} (${STATUS_NAMES[statusById.get(other) ?? 0] ?? "?"})`);
			duplicates.push(`  - ${describeRow(row)}: row's hardcover_id ${id}, already tracked as ${statuses.join(", ")}`);
			continue;
		}
		if (planned.has(id)) {
			continue;
		}
		planned.add(id);
		const dateAdded = (row.cells["DateAdded"] ?? "").trim();
		plan.changes.push({
			id: `push:${id}`,
			summary: `Add ${describeRow(row)} to Hardcover as Want to Read (hardcover_id ${id})`,
			details: [
				...(dateAdded ? [`date_added ${dateAdded}`] : []),
				"Hardcover picks no edition: you get a link to choose yours after pushing",
			],
			warnings: [],
			writesHardcover: true,
			selected: false,
			ready: true,
			payload: { bookId: Number(id), storedId: Number(storedId), dateAdded, slug: merged?.slug ?? extractHardcoverSlug(row.cells["hardcover_id"] ?? ""), name: describeRow(row) },
		});
	}

	plan.notes.push(
		`${plan.changes.length} row(s) to add to Hardcover as Want to Read. ${alreadyTracked} already on your Hardcover shelves (left alone), ` +
			`${noId.length} without a hardcover_id (can't push), ${duplicates.length} possible duplicate(s) (not pushed).`,
	);
	if (duplicates.length) {
		plan.notes.push("Possible duplicates (title + author match a book already tracked under another hardcover_id; not pushed, check by hand):", ...duplicates);
	}
	if (stale.length) {
		plan.notes.push("Hardcover merged these rows' hardcover_id into another book; checked as the new id (the labels step offers to update the row):", ...stale);
	}
	if (malformed.length) {
		plan.notes.push(`Rows whose cell count doesn't match the header (a stray "|"?), not pushed. Fix them by hand:`, ...malformed);
	}
	return plan;
}

export async function applyPush(ctx: WritingApplyContext, changes: Change<PushPayload>[]): Promise<ApplyResult> {
	const result = emptyResult();
	if (!changes.length) {
		return result;
	}
	// Asked again right before writing: a book added meanwhile (or by a first, interrupted apply) is not added twice
	const ids = changes.flatMap((c) => [c.payload.bookId, c.payload.storedId]);
	const onHardcover = new Set((await ctx.hardcover.finishedInfo(ids)).map((info) => String(info.book_id)));
	const pushed: PushPayload[] = [];
	let failure: string | null = null;
	for (const change of changes) {
		const payload = change.payload;
		if (failure) {
			result.skipped.push({ id: change.id, reason: `not tried after the error above (${failure})` });
		} else if (onHardcover.has(String(payload.bookId)) || onHardcover.has(String(payload.storedId))) {
			result.skipped.push({ id: change.id, reason: "already on your Hardcover shelves" });
		} else {
			try {
				const inserted = await ctx.hardcover.addWantToRead(payload.bookId, payload.dateAdded || undefined);
				if (inserted.error) {
					result.skipped.push({ id: change.id, reason: `Hardcover refused: ${inserted.error}` });
				} else {
					result.applied.push(change.id);
					pushed.push(payload);
				}
			} catch (err) {
				// A timed-out write may still have landed: the next run's re-check finds it
				failure = err instanceof Error ? err.message : String(err);
				result.skipped.push({ id: change.id, reason: failure });
			}
		}
	}
	if (pushed.length) result.todos = pushed.map((p) => ({
		key: `edition:${p.bookId}`,
		text: `${p.name}: pick your edition on Hardcover`,
		url: p.slug ? hardcoverBookUrl(p.slug) : undefined,
		check: { kind: "edition" as const, bookId: p.bookId },
	}));
	if (pushed.length) {
		result.messages.push(
			"IMPORTANT: these were added to Hardcover with no edition picked (insert_user_book takes none), so Hardcover shows a default edition. Choose the edition you own or read for each:",
			...pushed.map((p) => `  - ${p.name}: ${p.slug ? hardcoverBookUrl(p.slug) : "(no link, look it up by title)"}`),
		);
	}
	return result;
}

export const push: Step<PushPayload, WritingApplyContext> = {
	id: "backlog/push",
	plan: planPush,
	apply: applyPush,
};
