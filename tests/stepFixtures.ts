// Synthetic Books folder and stub clients for the step tests. All names and ids are made up.
import type { PlanContext } from "../src/steps/context";
import { DEFAULT_SETTINGS, BookSyncSettings } from "../src/settings";
import { renderRow } from "../src/core/table";
import { goodreadsLink, hardcoverLink } from "../src/core/idLinks";
import { MemoryVault } from "./memoryVault";

export const SETTINGS: BookSyncSettings = {
	...DEFAULT_SETTINGS,
	booksFolder: "Books",
	ownerName: "Sam",
	goodreadsRssUrl: "https://feeds.example/review/list_rss/1?key=KEY&shelf=to-read",
	openaiKey: "fake",
};
export const BACKLOG = "Books/Want to Read.md";
export const LISTS = "Books/Hardcover Lists.md";
export const DB = "Books/Database";

export const COLUMNS = ["Title", "Author", "DateAdded", "Genre", "Labels", "Notes", "isbn", "goodreads_id", "hardcover_id"];
const HEADER = `| ${COLUMNS.join(" | ")} |`;
const SEP = `| ${COLUMNS.map(() => "---").join(" | ")} |`;
const PREAMBLE = ["---", "cssclasses:", "  - wide", "---", "#books", "", "> [!note]- How to edit this table by hand", "> | a callout line, not the table", ""];

export interface RowValues {
	title?: string;
	author?: string;
	date?: string;
	genre?: string;
	labels?: string;
	notes?: string;
	isbn?: string;
	gr?: string;
	hc?: [number, string];
}

export function row(v: RowValues): string {
	return renderRow(COLUMNS, {
		Title: v.title ?? "",
		Author: v.author ?? "",
		DateAdded: v.date ?? "",
		Genre: v.genre ?? "",
		Labels: v.labels ?? "",
		Notes: v.notes ?? "",
		isbn: v.isbn ?? "",
		goodreads_id: goodreadsLink(v.gr),
		hardcover_id: v.hc ? hardcoverLink(v.hc[0], v.hc[1]) : "",
	});
}

export function backlogFile(rows: string[]): string {
	return [...PREAMBLE, HEADER, SEP, ...rows, "", "Text below the table.", ""].join("\n");
}

export interface NoteValues {
	title: string;
	author: string;
	hc?: number | string;
	gr?: string;
	dateRead?: string;
	labels?: string[];
	extra?: string;
}

export function noteText(v: NoteValues): string {
	return [
		"---",
		`author: ${v.author}`,
		`title: ${v.title}`,
		`dateRead: ${v.dateRead ?? ""}`.trimEnd(),
		`goodreads_id: ${v.gr ? `https://www.goodreads.com/book/show/${v.gr}` : ""}`.trimEnd(),
		`hardcover_id: ${v.hc ?? ""}`.trimEnd(),
		`hardcover_link: ${v.hc ? `https://hardcover.app/books/book-${v.hc}` : ""}`.trimEnd(),
		v.labels?.length ? `labels:\n${v.labels.map((l) => `  - ${l}`).join("\n")}` : "labels: []",
		"rating_10:",
		"language_read: English",
		"owned: Sam",
		"fiction: true",
		"medium: paper",
		...(v.extra ? [v.extra] : []),
		"---",
		`# ${v.title}`,
		"",
		"---",
		"find all books in [[../List of books]]",
		"",
	].join("\n");
}

export function notePath(title: string, author: string): string {
	return `${DB}/${author} - ${title}.md`;
}

const unexpected = (name: string) => async () => {
	throw new Error(`unexpected call: ${name}`);
};

/** A plan context whose clients throw unless the test overrides the methods it expects */
export function context(vault: MemoryVault, overrides: {
	hardcover?: Partial<PlanContext["hardcover"]>;
	goodreads?: Partial<PlanContext["goodreads"]>;
	openai?: Partial<PlanContext["openai"]>;
	settings?: Partial<BookSyncSettings>;
} = {}): PlanContext {
	return {
		vault,
		settings: { ...SETTINGS, ...overrides.settings },
		hardcover: {
			lookupIsbn: unexpected("lookupIsbn"),
			booksBySlug: unexpected("booksBySlug"),
			resolveMerges: async () => new Map(),
			readingStatuses: unexpected("readingStatuses"),
			userBookDetails: unexpected("userBookDetails"),
			finishedInfo: unexpected("finishedInfo"),
			...overrides.hardcover,
		},
		goodreads: { fetchShelf: unexpected("fetchShelf"), ...overrides.goodreads },
		openai: { proposeLabels: unexpected("proposeLabels"), refineLabels: unexpected("refineLabels"), ...overrides.openai },
	};
}
