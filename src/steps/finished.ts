// archive/finished: notes with a blank dateRead whose book is Read on Hardcover get dateRead, rating_10 and the
// Hardcover review. Port of check_finished_from_hardcover.py. Hardcover wins for dates read and rating; a missing
// rating or review is reported, not waited for. Ids are resolved through Hardcover's merges first.

import { noteFieldsTodo } from "../core/todos";
import type { ApplyResult, Change, Plan } from "../core/changes";
import { emptyResult } from "../core/changes";
import { applyFinished, stillNeededFields, toRating10 } from "../core/databaseNote";
import { getField } from "../core/frontmatter";
import { ApplyContext, describeNote, loadNotes, PlanContext, Step } from "./context";
import { applyMerge, mergeChange, MergePayload } from "./merges";

const STATUS_NAMES: Record<number, string> = { 1: "Want to Read", 2: "Currently Reading", 3: "Read", 4: "Paused", 5: "DNF", 6: "Ignored" };

export type FinishedPayload =
	| {
			kind: "finished";
			path: string;
			/** Null when Hardcover has no read date: dateRead stays as it is */
			dateRead: string | null;
			rating10: number | null;
			review: string | null;
	  }
	| MergePayload;

export async function planFinished(ctx: PlanContext): Promise<Plan<FinishedPayload>> {
	const notes = await loadNotes(ctx.vault, ctx.settings);
	const plan: Plan<FinishedPayload> = { step: "archive/finished", changes: [], notes: [] };
	const open = notes.filter((n) => !n.note.dateRead);
	const noId = open.filter((n) => !n.note.hardcoverId);
	const candidates = open.filter((n) => n.note.hardcoverId);

	plan.notes.push(`${notes.length} Database/ notes, ${candidates.length} with a hardcover_id and a blank dateRead.`);
	if (noId.length) {
		plan.notes.push(`${noId.length} note(s) have a blank dateRead but no hardcover_id (can't check):`, ...noId.map((n) => `  - ${describeNote(n.note)}`));
	}
	if (!candidates.length) {
		plan.notes.push("Nothing to check.");
		return plan;
	}

	const merges = await ctx.hardcover.resolveMerges(candidates.map((n) => n.note.hardcoverId as string));
	const canonical = (id: string) => (merges.has(id) ? String(merges.get(id)!.id) : id);
	for (const { note } of candidates) {
		const merged = merges.get(note.hardcoverId as string);
		if (merged) {
			plan.changes.push(mergeChange(note, merged));
		}
	}

	const infos = await ctx.hardcover.finishedInfo(candidates.map((n) => canonical(n.note.hardcoverId as string)));
	const byId = new Map(infos.map((info) => [String(info.book_id), info]));
	const noUserBook: string[] = [];
	const reading: string[] = [];
	for (const { note, text } of candidates) {
		const info = byId.get(canonical(note.hardcoverId as string));
		if (!info) {
			noUserBook.push(`  - ${describeNote(note)}`);
			continue;
		}
		if (info.status_id !== 3) {
			reading.push(`  - ${describeNote(note)} (${STATUS_NAMES[info.status_id] ?? info.status_id})`);
			continue;
		}
		const rating10 = toRating10(info.rating);
		const review = info.review?.trim() ? info.review : null;
		const missing = [...(rating10 === null ? ["rating"] : []), ...(review ? [] : ["review"])];
		const stillNeeded = stillNeededFields(text);
		plan.changes.push({
			id: `finished:${note.path}`,
			summary: `${describeNote(note)} finished: dateRead -> ${info.first_read_date ?? "(none)"}, rating_10 -> ${rating10 ?? "(none)"}${review ? ", plus the Hardcover review" : ""}`,
			details: stillNeeded.length ? [`Still needs by hand on the note: ${stillNeeded.join(", ")}`] : [],
			warnings: [
				...(missing.length ? [`Missing on Hardcover: ${missing.join(", ")}`] : []),
				...(info.first_read_date ? [] : ["Hardcover has no read date for it: dateRead stays blank"]),
			],
			writesHardcover: false,
			selected: true,
			ready: true,
			file: note.path,
			payload: { kind: "finished", path: note.path, dateRead: info.first_read_date, rating10, review },
		});
	}
	if (noUserBook.length) {
		plan.notes.push(`${noUserBook.length} note(s) have no matching book on your Hardcover shelves (skipped):`, ...noUserBook);
	}
	if (reading.length) {
		plan.notes.push(`${reading.length} note(s) not marked Read on Hardcover yet:`, ...reading);
	}
	if (!plan.changes.length) {
		plan.notes.push("No newly finished books, nothing to update.");
	}
	return plan;
}

export async function applyFinishedStep(ctx: ApplyContext, changes: Change<FinishedPayload>[]): Promise<ApplyResult> {
	const result = emptyResult();
	for (const change of changes) {
		const payload = change.payload;
		if (payload.kind === "merge") {
			const reason = await applyMerge(ctx.vault, payload);
			if (reason) {
				result.skipped.push({ id: change.id, reason });
			} else {
				result.applied.push(change.id);
			}
			continue;
		}
		if ((await ctx.vault.read(payload.path)) === null) {
			result.skipped.push({ id: change.id, reason: "note not found" });
			continue;
		}
		const text = await ctx.vault.process(payload.path, (current) =>
			applyFinished(current, payload.dateRead ?? getField(current, "dateRead") ?? "", payload.rating10, payload.review),
		);
		result.applied.push(change.id);
		const stillNeeded = stillNeededFields(text);
		const name = payload.path.split("/").pop();
		(result.todos ??= []).push(...noteFieldsTodo(payload.path, name!.replace(/\.md$/, ""), stillNeeded));
		result.messages.push(`Updated ${name}.${stillNeeded.length ? ` Still needs by hand: ${stillNeeded.join(", ")}.` : ""}`);
	}
	return result;
}

export const finished: Step<FinishedPayload> = {
	id: "archive/finished",
	plan: planFinished,
	apply: applyFinishedStep,
};
