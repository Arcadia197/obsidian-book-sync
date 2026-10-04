// archive/reconcile: backlog rows whose book already has a Database/ note (e.g. a note made by hand) are removed.
// Port of reconcile_promoted.py. The user updates Goodreads by hand at the same time, so every removal is reviewed.

import type { ApplyResult, Change, Plan, VaultWriter } from "../core/changes";
import { emptyResult } from "../core/changes";
import { serializeTable } from "../core/table";
import type { BookSyncSettings } from "../settings";
import { ApplyContext, describeRow, findRow, loadBacklog, loadNotes, parseBacklog, paths, PlanContext, rowGoodreadsId, RowKey, rowKey, Step } from "./context";

export interface RemoveRowPayload {
	key: RowKey;
}

/** A backlog row's Notes, shown before it goes: never carried over automatically */
export function notesWarning(notes: string | undefined): string[] {
	const text = (notes ?? "").trim();
	return text ? [`Backlog Notes, not carried over (copy by hand if still relevant): ${text}`] : [];
}

/** Removes the rows with these keys in one write. Returns the keys that were found, by index */
export async function removeRows(vault: VaultWriter, settings: BookSyncSettings, keys: RowKey[]): Promise<boolean[]> {
	const found = keys.map(() => false);
	if (!keys.length) {
		return found;
	}
	const path = paths(settings).backlog;
	await vault.process(path, (text) => {
		const table = parseBacklog(text, path);
		keys.forEach((key, i) => {
			const row = findRow(table, key);
			if (row) {
				table.rows.splice(table.rows.indexOf(row), 1);
				found[i] = true;
			}
		});
		return serializeTable(table);
	});
	return found;
}

export const GOODREADS_REMINDER = "Remember to update the removed books' status on Goodreads by hand.";

export async function planReconcile(ctx: PlanContext): Promise<Plan<RemoveRowPayload>> {
	const notes = await loadNotes(ctx.vault, ctx.settings);
	const table = await loadBacklog(ctx.vault, ctx.settings);
	const noteByGoodreadsId = new Map<string, string>();
	for (const { note } of notes) {
		if (note.goodreadsId && !noteByGoodreadsId.has(note.goodreadsId)) {
			noteByGoodreadsId.set(note.goodreadsId, note.path);
		}
	}
	const plan: Plan<RemoveRowPayload> = { step: "archive/reconcile", changes: [], notes: [] };
	for (const row of table.rows) {
		const id = rowGoodreadsId(row);
		const notePath = id ? noteByGoodreadsId.get(id) : undefined;
		if (!id || !notePath) {
			continue;
		}
		plan.changes.push({
			id: `remove:${id}`,
			summary: `Remove ${describeRow(row)} from the backlog: it has a Database/ note (${notePath.split("/").pop()})`,
			details: [],
			warnings: notesWarning(row.cells["Notes"]),
			writesHardcover: false,
			selected: true,
			ready: true,
			payload: { key: rowKey(row) },
		});
	}
	if (!plan.changes.length) {
		plan.notes.push("No backlog rows with a Database/ note, nothing to remove.");
	}
	return plan;
}

export async function applyReconcile(ctx: ApplyContext, changes: Change<RemoveRowPayload>[]): Promise<ApplyResult> {
	const result = emptyResult();
	const found = await removeRows(ctx.vault, ctx.settings, changes.map((c) => c.payload.key));
	changes.forEach((change, i) => {
		if (found[i]) {
			result.applied.push(change.id);
		} else {
			result.skipped.push({ id: change.id, reason: "row not found (already removed or changed)" });
		}
	});
	if (result.applied.length) {
		result.messages.push(GOODREADS_REMINDER);
	}
	return result;
}

export const reconcile: Step<RemoveRowPayload> = {
	id: "archive/reconcile",
	plan: planReconcile,
	apply: applyReconcile,
};
