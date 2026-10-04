// backlog/pullGoodreads: the Goodreads to-read shelf into Want to Read.md. Port of pull_goodreads_to_read.py.
// - New books become rows; their Labels come from an AI suggestion the user can edit or refine in plain language,
//   and only labels from the vocabulary (Database/ notes' `labels`) are written
// - Existing rows (by goodreads_id): Title, Author and isbn only while blank, DateAdded always (Goodreads owns it).
//   Genre, Labels, Notes and hardcover_id are never touched
// - Books that already have a Database/ note are reported, not added
// - Rows without a readable goodreads_id and malformed rows are kept as they are, with a warning
// - The table is sorted by DateAdded, newest first, whenever this step writes

import type { ApplyResult, Change, Plan } from "../core/changes";
import { emptyResult } from "../core/changes";
import { goodreadsLink } from "../core/idLinks";
import { labelGuidance } from "../core/listsMapping";
import { addRow, joinList, serializeTable, setCell, sortRowsDesc, splitList, Table, TableRow } from "../core/table";
import type { ShelfEntry } from "../api/goodreads";
import { LabelProposals, labelVocabulary, Vocabulary } from "../api/openai";
import {
	ApplyContext,
	describeRow,
	findRow,
	loadBacklog,
	loadNotes,
	parseBacklog,
	paths,
	PlanContext,
	rowGoodreadsId,
	RowKey,
	rowKey,
	Step,
} from "./context";

export interface FieldChange {
	column: string;
	from: string;
	to: string;
}

export type PullPayload =
	| { kind: "add"; entry: ShelfEntry; vocabulary: string[] }
	| { kind: "update"; key: RowKey; entry: ShelfEntry; fields: FieldChange[] }
	| { kind: "sort" };

export interface PullOptions {
	/** Ask OpenAI for Labels of new rows (default true). The parity script turns it off */
	labelSuggestions?: boolean;
}

/** Field changes Goodreads makes to an existing row: fill-if-blank for Title/Author/isbn, DateAdded and the id link always */
export function rowUpdates(row: TableRow, entry: ShelfEntry): FieldChange[] {
	const fields: FieldChange[] = [];
	const current = (column: string) => row.cells[column] ?? "";
	for (const [column, value] of [["Title", entry.title], ["Author", entry.author], ["isbn", entry.isbn]] as const) {
		if (!current(column) && value) {
			fields.push({ column, from: "", to: value });
		}
	}
	// A feed without a date would blank a right one (the Python writes the blank); keep what's there
	if (entry.dateAdded && current("DateAdded") !== entry.dateAdded) {
		fields.push({ column: "DateAdded", from: current("DateAdded"), to: entry.dateAdded });
	}
	const link = goodreadsLink(entry.goodreadsId);
	if (current("goodreads_id") !== link) {
		fields.push({ column: "goodreads_id", from: current("goodreads_id"), to: link });
	}
	return fields;
}

function isSorted(table: Table): boolean {
	return table.rows.every((row, i) => i === 0 || (table.rows[i - 1].cells["DateAdded"] ?? "") >= (row.cells["DateAdded"] ?? ""));
}

function labelsInput(value: string, vocabulary: string[]) {
	return {
		kind: "labels" as const,
		prompt: "Labels (comma-separated, from the labels already used in Database/)",
		value,
		options: vocabulary,
	};
}

export async function planPull(ctx: PlanContext, options: PullOptions = {}): Promise<Plan<PullPayload>> {
	const entries = await ctx.goodreads.fetchShelf(ctx.settings.goodreadsRssUrl);
	const notes = await loadNotes(ctx.vault, ctx.settings);
	const table = await loadBacklog(ctx.vault, ctx.settings);
	const archivedIds = new Set(notes.map((n) => n.note.goodreadsId).filter((id): id is string => !!id));

	const plan: Plan<PullPayload> = { step: "backlog/pullGoodreads", changes: [], notes: [] };
	const byId = new Map<string, TableRow>();
	for (const row of table.rows) {
		const id = rowGoodreadsId(row);
		if (!id) {
			continue;
		}
		if (byId.has(id)) {
			plan.notes.push(`Two rows have goodreads_id ${id}; only the first gets Goodreads updates: ${describeRow(row)}`);
		} else {
			byId.set(id, row);
		}
	}

	const vocabulary = labelVocabulary(notes.map((n) => n.note));
	const vocabularyList = [...vocabulary.keys()].sort();
	const archived: ShelfEntry[] = [];
	const added: Change<PullPayload>[] = [];
	let alreadyListed = 0;
	for (const entry of entries) {
		const id = entry.goodreadsId;
		if (archivedIds.has(id)) {
			archived.push(entry);
			continue;
		}
		const row = byId.get(id);
		if (!row) {
			const change: Change<PullPayload> = {
				id: `add:${id}`,
				summary: `Add ${entry.title} (${entry.author})`,
				details: [`DateAdded ${entry.dateAdded || "(none)"}, isbn ${entry.isbn || "(none)"}`],
				warnings: [],
				writesHardcover: false,
				selected: true,
				ready: true,
				input: labelsInput("", vocabularyList),
				payload: { kind: "add", entry, vocabulary: vocabularyList },
			};
			added.push(change);
			plan.changes.push(change);
			continue;
		}
		alreadyListed++;
		if (row.malformed) {
			plan.notes.push(`${describeRow(row)}: the row's cell count doesn't match the header (a stray "|"?), so Goodreads updates are skipped. Fix the row by hand.`);
			continue;
		}
		const fields = rowUpdates(row, entry);
		if (fields.length) {
			plan.changes.push({
				id: `update:${id}`,
				summary: `Update ${describeRow(row)}`,
				details: fields.map((f) => `${f.column}: ${f.from || "(blank)"} -> ${f.to}`),
				warnings: [],
				writesHardcover: false,
				selected: true,
				ready: true,
				payload: { kind: "update", key: rowKey(row), entry, fields },
			});
		}
	}

	plan.notes.unshift(`Found ${entries.length} books on the Goodreads shelf. ${added.length} are new; ${alreadyListed} already in the backlog.`);
	if (archived.length) {
		plan.notes.push(
			`${archived.length} book(s) on the shelf already have a Database/ note (maybe already started or finished), skipped. Remove them from the Goodreads shelf by hand if they really started:`,
			...archived.map((e) => `  - ${e.title} (${e.author})`),
		);
	}
	const unkeyed = table.rows.filter((row) => !rowGoodreadsId(row));
	if (unkeyed.length) {
		plan.notes.push(
			`${unkeyed.length} row(s) have no readable goodreads_id: kept as they are, but get no Goodreads updates until you fill it in:`,
			...unkeyed.map((row) => `  - ${describeRow(row)}`),
		);
	}
	if (!isSorted(table)) {
		plan.changes.push({
			id: "sort",
			summary: "Sort the table by DateAdded, newest first (rows are out of order)",
			details: [],
			warnings: [],
			writesHardcover: false,
			selected: true,
			ready: true,
			payload: { kind: "sort" },
		});
	}

	if (added.length && options.labelSuggestions !== false) {
		await suggestLabels(ctx, added, vocabulary, plan.notes);
	}
	return plan;
}

function labelRequests(changes: Change<PullPayload>[]) {
	return changes.flatMap((change) =>
		change.payload.kind === "add" ? [{ id: change.payload.entry.goodreadsId, title: change.payload.entry.title, author: change.payload.entry.author }] : [],
	);
}

async function guidance(ctx: PlanContext): Promise<string> {
	const text = await ctx.vault.read(paths(ctx.settings).lists);
	return text ? labelGuidance(text) : "";
}

async function suggestLabels(ctx: PlanContext, added: Change<PullPayload>[], vocabulary: Vocabulary, notes: string[]): Promise<void> {
	if (!ctx.settings.openaiKey) {
		notes.push("No OpenAI API key set: no label suggestions, fill in Labels by hand.");
		return;
	}
	if (!vocabulary.size) {
		notes.push("No labels in Database/ notes yet, so there is nothing to suggest from.");
		return;
	}
	try {
		const proposals = await ctx.openai.proposeLabels(labelRequests(added), vocabulary, await guidance(ctx));
		setLabelInputs(added, proposals);
	} catch (err) {
		notes.push(`Label suggestion failed (${(err as Error).message}): fill in Labels by hand.`);
	}
}

function setLabelInputs(changes: Change<PullPayload>[], proposals: LabelProposals): void {
	for (const change of changes) {
		if (change.payload.kind === "add" && change.input) {
			change.input.value = joinList(proposals[change.payload.entry.goodreadsId] ?? []);
		}
	}
}

/**
 * Revises the Labels of every new row from plain-language feedback ("make the second one erotica too"). The current
 * field values, including hand edits, are what the AI revises. Port of refine_labels() in propose_labels.py
 */
export async function refinePullLabels(ctx: PlanContext, plan: Plan<PullPayload>, feedback: string): Promise<void> {
	const added = plan.changes.filter((change) => change.payload.kind === "add");
	if (!added.length || !feedback.trim()) {
		return;
	}
	const notes = await loadNotes(ctx.vault, ctx.settings);
	const vocabulary = labelVocabulary(notes.map((n) => n.note));
	const current: LabelProposals = {};
	for (const change of added) {
		if (change.payload.kind === "add") {
			current[change.payload.entry.goodreadsId] = splitList(change.input?.value ?? "");
		}
	}
	setLabelInputs(added, await ctx.openai.refineLabels(labelRequests(added), current, feedback, vocabulary, await guidance(ctx)));
}

/** Labels as the vocabulary spells them (case-insensitive match); unknown ones are dropped. An empty vocabulary keeps all */
export function vocabularyLabels(value: string, vocabulary: string[]): { kept: string[]; dropped: string[] } {
	const labels = splitList(value);
	if (!vocabulary.length) {
		return { kept: labels, dropped: [] };
	}
	const spelling = new Map(vocabulary.map((label) => [label.toLowerCase(), label]));
	const kept: string[] = [];
	const dropped: string[] = [];
	for (const label of labels) {
		const known = spelling.get(label.toLowerCase());
		if (known && !kept.includes(known)) {
			kept.push(known);
		} else if (!known) {
			dropped.push(label);
		}
	}
	return { kept, dropped };
}

export async function applyPull(ctx: ApplyContext, changes: Change<PullPayload>[]): Promise<ApplyResult> {
	const result = emptyResult();
	if (!changes.length) {
		return result;
	}
	const path = paths(ctx.settings).backlog;
	let blankLabels = 0;
	await ctx.vault.process(path, (text) => {
		const table = parseBacklog(text, path);
		for (const change of changes) {
			const payload = change.payload;
			if (payload.kind === "add") {
				const { entry } = payload;
				if (table.rows.some((row) => rowGoodreadsId(row) === entry.goodreadsId)) {
					result.skipped.push({ id: change.id, reason: "already in the table" });
					continue;
				}
				const { kept, dropped } = vocabularyLabels(change.input?.value ?? "", payload.vocabulary);
				if (dropped.length) {
					result.messages.push(`${entry.title}: dropped labels not used in Database/ yet: ${dropped.join(", ")}`);
				}
				if (!kept.length) {
					blankLabels++;
				}
				addRow(table, {
					Title: entry.title,
					Author: entry.author,
					DateAdded: entry.dateAdded,
					Labels: joinList(kept),
					isbn: entry.isbn,
					goodreads_id: goodreadsLink(entry.goodreadsId),
				});
			} else if (payload.kind === "update") {
				const row = findRow(table, payload.key);
				if (!row || row.malformed) {
					result.skipped.push({ id: change.id, reason: row ? "the row's cell count doesn't match the header" : "row not found (changed since the plan)" });
					continue;
				}
				for (const field of payload.fields) {
					// Fill-if-blank is checked again on the current text: a hand edit since the plan wins
					if (field.column === "DateAdded" || field.column === "goodreads_id" || !row.cells[field.column]) {
						setCell(table, row, field.column, field.to);
					}
				}
			}
			result.applied.push(change.id);
		}
		sortRowsDesc(table, "DateAdded");
		return serializeTable(table);
	});
	if (blankLabels) {
		result.messages.push(`${blankLabels} new row(s) have no Labels yet. Fill them in before the labels sync: it pushes whatever is in the Labels column to Hardcover.`);
	}
	return result;
}

export const pullGoodreads: Step<PullPayload> = {
	id: "backlog/pullGoodreads",
	plan: (ctx) => planPull(ctx),
	apply: applyPull,
};
