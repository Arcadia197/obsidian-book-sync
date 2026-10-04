// What every step gets, and the file loading they share. No obsidian import: the steps run in unit tests and in the
// parity script too.

import type { Change, ApplyResult, Plan, StepId, VaultReader, VaultWriter } from "../core/changes";
import { DatabaseNote, readDatabaseNote } from "../core/databaseNote";
import { extractId, goodreadsIdFromUrl } from "../core/idLinks";
import { parseTable, Table, TableRow } from "../core/table";
import type { GoodreadsClient } from "../api/goodreads";
import type { HardcoverReader } from "../api/hardcover";
import type { OpenAiClient } from "../api/openai";
import { BookSyncSettings, booksPath } from "../settings";

/** Hardcover reads the steps use. A reader, never a writer: plan() can't write by construction */
export type HardcoverReads = Pick<
	HardcoverReader,
	"lookupIsbn" | "booksBySlug" | "resolveMerges" | "readingStatuses" | "userBookDetails" | "finishedInfo"
>;
export type GoodreadsReads = Pick<GoodreadsClient, "fetchShelf">;
export type LabelSuggester = Pick<OpenAiClient, "proposeLabels" | "refineLabels">;

export interface PlanContext {
	vault: VaultReader;
	settings: BookSyncSettings;
	hardcover: HardcoverReads;
	goodreads: GoodreadsReads;
	openai: LabelSuggester;
}

/** The steps of this module write only local files */
export interface ApplyContext {
	vault: VaultWriter;
	settings: BookSyncSettings;
}

export interface Step<P = unknown> {
	id: StepId;
	plan(ctx: PlanContext): Promise<Plan<P>>;
	/** Gets only the ticked, ready changes (see selectedChanges) */
	apply(ctx: ApplyContext, changes: Change<P>[]): Promise<ApplyResult>;
}

export interface Paths {
	backlog: string;
	lists: string;
	database: string;
}

export function paths(settings: BookSyncSettings): Paths {
	return {
		backlog: booksPath(settings, settings.wantToReadFile),
		lists: booksPath(settings, settings.hardcoverListsFile),
		database: booksPath(settings, settings.databaseFolder),
	};
}

/** The backlog table. Throws a clear error if the file or its "Title" table is missing */
export function parseBacklog(text: string | null, path: string): Table {
	if (text === null) {
		throw new Error(`${path} not found. Check the Want to Read file in the plugin settings.`);
	}
	const table = parseTable(text, "Title");
	if (!table) {
		throw new Error(`No table with a "Title" column in ${path}. Restore the header row, or check the settings.`);
	}
	return table;
}

export async function loadBacklog(vault: VaultReader, settings: BookSyncSettings): Promise<Table> {
	const path = paths(settings).backlog;
	return parseBacklog(await vault.read(path), path);
}

export interface NoteFile {
	note: DatabaseNote;
	text: string;
}

/** Every note in the Database folder, sorted by path (as the Python's sorted(glob)) */
export async function loadNotes(vault: VaultReader, settings: BookSyncSettings): Promise<NoteFile[]> {
	const notes: NoteFile[] = [];
	for (const path of await vault.listNotes(paths(settings).database)) {
		const text = await vault.read(path);
		if (text !== null) {
			notes.push({ note: readDatabaseNote(path, text), text });
		}
	}
	return notes;
}

/**
 * A row's Goodreads id, or null if it has none that can be read. A malformed row's cells may be shifted, so its id
 * is taken from a Goodreads URL anywhere in its line instead.
 */
export function rowGoodreadsId(row: TableRow): string | null {
	if (row.malformed) {
		return goodreadsIdFromUrl(row.original ?? "");
	}
	const id = extractId(row.cells["goodreads_id"] ?? "");
	return /^\d+$/.test(id) ? id : null;
}

/** A row's Hardcover book id, or null. For a malformed row, from a hardcover.app book link anywhere in its line */
export function rowHardcoverId(row: TableRow): string | null {
	if (row.malformed) {
		return /\[(\d+)\]\(https:\/\/hardcover\.app\/books\//.exec(row.original ?? "")?.[1] ?? null;
	}
	const id = extractId(row.cells["hardcover_id"] ?? "");
	return /^\d+$/.test(id) ? id : null;
}

/** How a change finds its row again in the file's current text */
export interface RowKey {
	goodreadsId: string | null;
	/** The row's line as planned, for rows without a Goodreads id */
	line: string | null;
}

export function rowKey(row: TableRow): RowKey {
	return { goodreadsId: rowGoodreadsId(row), line: row.original };
}

export function findRow(table: Table, key: RowKey): TableRow | null {
	if (key.goodreadsId) {
		return table.rows.find((row) => rowGoodreadsId(row) === key.goodreadsId) ?? null;
	}
	return key.line === null ? null : table.rows.find((row) => row.original === key.line) ?? null;
}

/** "Title (Author)" for messages */
export function describeRow(row: TableRow): string {
	return `${row.cells["Title"] || "?"} (${row.cells["Author"] || "?"})`;
}

export function describeNote(note: DatabaseNote): string {
	return `${note.author || "?"} - ${note.title}`;
}
