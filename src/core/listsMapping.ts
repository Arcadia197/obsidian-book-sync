// Hardcover Lists.md: a `Label | hardcover_list` table mapping a label to a Hardcover list, plus a hand-written
// section on what the labels mean (given to the AI word for word). A blank Label means "leave this list alone".

import { extractHardcoverListSlug, extractId, hardcoverListLink } from "./idLinks";
import { addRow, parseTable, serializeTable, Table } from "./table";

export interface MappedList {
	/** The label as written in the mapping (display casing) */
	label: string;
	listId: number;
	slug: string | null;
}

export interface ListsMapping {
	table: Table;
	/** By lowercased label: labels match case-insensitively */
	mapped: Map<string, MappedList>;
	/** Rows with a label but no readable list id: skipped, worth a warning */
	unreadable: string[];
}

/** The mapping, or null if the file has no table with a "Label" column */
export function parseListsMapping(text: string): ListsMapping | null {
	const table = parseTable(text, "Label");
	if (!table) {
		return null;
	}
	const mapped = new Map<string, MappedList>();
	const unreadable: string[] = [];
	for (const row of table.rows) {
		const label = (row.cells["Label"] ?? "").trim();
		if (!label) {
			continue;
		}
		const cell = row.cells["hardcover_list"] ?? "";
		const id = extractId(cell);
		if (!/^\d+$/.test(id)) {
			unreadable.push(label);
			continue;
		}
		mapped.set(label.toLowerCase(), { label, listId: Number(id), slug: extractHardcoverListSlug(cell) });
	}
	return { table, mapped, unreadable };
}

/**
 * The file with one more mapping row at the end of the table. Called right after each list is created, so a run
 * interrupted later never loses track of a list that already exists on Hardcover.
 */
export function appendMapping(text: string, label: string, listId: number, slug: string): string {
	const table = parseTable(text, "Label");
	if (!table) {
		throw new Error('No table with a "Label" column to add the mapping to');
	}
	addRow(table, { Label: label, hardcover_list: hardcoverListLink(listId, slug) });
	return serializeTable(table);
}

// The bold heading line that introduces the section, e.g. "**2026-09-23: how Julius means these labels ...:**",
// up to the mapping table. Matched by its wording, since the date in it changes when it's edited.
const GUIDANCE_RE = /\*\*[^\n]*means these labels[^\n]*\*\*\s*\n([\s\S]*?)\n\s*\|\s*Label/;

/** The hand-written section on what the labels mean, or "" if it's missing (a bonus for the AI, not a requirement) */
export function labelGuidance(text: string): string {
	return GUIDANCE_RE.exec(text)?.[1].trim() ?? "";
}
