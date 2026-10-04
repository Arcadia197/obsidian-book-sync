// A note whose hardcover_id Hardcover merged into another book: the step still matches through the merge, and offers
// to point the note (or backlog row) at the surviving book. Shared by promote, finished and labels
// (hardcover_merges.py's on-file fix).

import type { Change, VaultWriter } from "../core/changes";
import { DatabaseNote, setHardcoverId } from "../core/databaseNote";
import { getField } from "../core/frontmatter";
import { hardcoverLink } from "../core/idLinks";
import { setCell, Table, TableRow } from "../core/table";
import type { BookRef } from "../api/hardcover";
import { describeNote, describeRow, rowHardcoverId, RowKey, rowKey } from "./context";

export interface MergePayload {
	kind: "merge";
	path: string;
	oldId: string;
	newId: number;
	slug: string;
}

export function mergeChange(note: DatabaseNote, merged: BookRef): Change<MergePayload> {
	return {
		id: `merge:${note.path}`,
		summary: `${describeNote(note)}: Hardcover merged hardcover_id ${note.hardcoverId} into ${merged.id} (${merged.slug}). Update hardcover_id and hardcover_link`,
		details: ["Left as it is, the note still matches through the merge on every run"],
		warnings: [],
		writesHardcover: false,
		selected: true,
		ready: true,
		payload: { kind: "merge", path: note.path, oldId: note.hardcoverId ?? "", newId: merged.id, slug: merged.slug },
	};
}

/** Null when written, else why it was skipped */
export async function applyMerge(vault: VaultWriter, payload: MergePayload): Promise<string | null> {
	if ((await vault.read(payload.path)) === null) {
		return "note not found";
	}
	let reason: string | null = null;
	await vault.process(payload.path, (text) => {
		if (getField(text, "hardcover_id") !== payload.oldId) {
			reason = "hardcover_id changed since the plan";
			return text;
		}
		return setHardcoverId(text, payload.newId, payload.slug);
	});
	return reason;
}

/** The same fix for a backlog row (sync_hardcover_labels.py offers it for rows too) */
export interface RowMergePayload {
	kind: "mergeRow";
	key: RowKey;
	oldId: string;
	newId: number;
	slug: string;
}

/** `ref`: unique per row within the plan */
export function mergeRowChange(row: TableRow, merged: BookRef, ref: string): Change<RowMergePayload> {
	const key = rowKey(row);
	const oldId = rowHardcoverId(row) ?? "";
	return {
		id: `mergeRow:${ref}`,
		summary: `${describeRow(row)} (Want to Read): Hardcover merged hardcover_id ${oldId} into ${merged.id} (${merged.slug}). Update the row's hardcover_id`,
		details: ["Left as it is, the row still matches through the merge on every run"],
		warnings: [],
		writesHardcover: false,
		selected: true,
		ready: true,
		payload: { kind: "mergeRow", key, oldId, newId: merged.id, slug: merged.slug },
	};
}

/**
 * Updates a row already found in the table being edited; why it was skipped, or null when written. The caller finds
 * every row before editing any: an edited row can't be found by its planned line anymore
 */
export function applyRowMerge(table: Table, row: TableRow | null, payload: RowMergePayload): string | null {
	if (!row || row.malformed) {
		return "row not found (changed since the plan)";
	}
	if (rowHardcoverId(row) !== payload.oldId) {
		return "hardcover_id changed since the plan";
	}
	setCell(table, row, "hardcover_id", hardcoverLink(payload.newId, payload.slug));
	return null;
}
