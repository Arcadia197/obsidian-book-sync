// A note whose hardcover_id Hardcover merged into another book: the step still matches through the merge, and offers
// to point the note at the surviving book. Shared by promote and finished (hardcover_merges.py's on-file fix).

import type { Change, VaultWriter } from "../core/changes";
import { DatabaseNote, setHardcoverId } from "../core/databaseNote";
import { getField } from "../core/frontmatter";
import type { BookRef } from "../api/hardcover";
import { describeNote } from "./context";

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
