// A new Database/ note for a book that moved to Currently Reading or Read on Hardcover. Port of
// build_note_text() in promote_from_hardcover.py, same key order and body.
// Edition vs book: title, isbn, cover, pages, language and author come from the edition on the user's shelf;
// datePublished stays book-level (the work's first publication).

import { renderList, LABELS_STYLE, OWNED_STYLE } from "./frontmatter";
import { goodreadsBookUrl, hardcoverBookUrl } from "./idLinks";
import { isOwnedLabel, toRating10 } from "./databaseNote";
import type { HardcoverBook, HardcoverContribution, HardcoverUserBook } from "./hardcoverTypes";
import { splitList } from "./table";

/** What the Want to Read.md row (if any) carries over into the note */
export interface BacklogInfo {
	/** Bare Goodreads book id, "" if unknown */
	goodreadsId: string;
	/** Comma-separated, as in the row's Genre cell */
	genre: string;
	/** Comma-separated, as in the row's Labels cell */
	labels: string;
}

export interface SeriesGuess {
	name: string;
	position: number | null;
	total: number | null;
}

export interface BuiltNote {
	text: string;
	/** `Author - Title.md` */
	filename: string;
	author: string;
	title: string;
	/** A guess from Hardcover's series data: always shown as "needs review" */
	series: SeriesGuess | null;
	/** Fields left for the human, for the review window */
	stillNeeded: string[];
	/** No edition picked on Hardcover: edition fields fell back to the book's defaults. Warn loudly */
	noEdition: boolean;
}

/** Credits as "Author" or with no label; translators, narrators etc. only if nobody else is credited */
export function primaryAuthorNames(contributions: HardcoverContribution[]): string {
	const primary = contributions
		.filter((c) => !c.contribution || c.contribution === "Author")
		.map((c) => c.author.name);
	return (primary.length ? primary : contributions.map((c) => c.author.name)).join(", ");
}

export function chooseTitle(entry: HardcoverUserBook): string {
	return entry.edition?.title || entry.book.title;
}

export function chooseAuthor(entry: HardcoverUserBook): string {
	const editionCredits = entry.edition?.contributions;
	return primaryAuthorNames(editionCredits?.length ? editionCredits : entry.book.contributions);
}

function chooseIsbn(entry: HardcoverUserBook): string {
	return entry.edition?.isbn_10 || entry.edition?.isbn_13 || "";
}

function chooseCover(entry: HardcoverUserBook): string {
	if (entry.edition?.image) {
		return entry.edition.image.url ?? "";
	}
	return entry.book.image?.url ?? "";
}

function choosePages(entry: HardcoverUserBook): string {
	return String(entry.edition?.pages || entry.book.pages || "");
}

function chooseLanguage(entry: HardcoverUserBook): string {
	return entry.edition?.language?.language ?? "";
}

function chooseFiction(book: HardcoverBook): string {
	return book.literary_type_id === 1 ? "true" : book.literary_type_id === 2 ? "false" : "";
}

/** The featured series, else the first series marked featured, else the first one */
export function pickSeries(book: HardcoverBook): SeriesGuess | null {
	const candidates = book.book_series ?? [];
	const chosen = book.featured_book_series || candidates.find((c) => c.featured) || candidates[0];
	if (!chosen?.series) {
		return null;
	}
	const series = chosen.series;
	return {
		name: series.name,
		position: chosen.position ?? null,
		total: series.primary_books_count || series.books_count || null,
	};
}

/** A YAML scalar: bare when safe, double-quoted (escaped) otherwise, "" for nothing */
export function yamlScalar(value: string | number | null | undefined): string {
	if (value === null || value === undefined || value === "") {
		return "";
	}
	const s = String(value);
	const needsQuote = "-?:,[]{}#&*!|>'\"%@`".includes(s[0]) || s.includes(":") || s.includes("#") || s.includes("\n") || s !== s.trim();
	return needsQuote ? `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : s;
}

/** Without characters that are unsafe in file names (and apostrophes), whitespace collapsed */
export function sanitizeFilenamePart(s: string): string {
	return s
		.replace(/[\\/:*?"<>|']/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function noteFilename(author: string, title: string): string {
	return `${sanitizeFilenamePart(author)} - ${sanitizeFilenamePart(title)}.md`;
}

/**
 * The note for `entry`. `backlog` is the Want to Read.md row it came from, or null for a book that never had one
 * (then goodreads_id, genre and labels stay blank). Owned is filled with `ownerName` only when Hardcover says the
 * user owns it; blank means "not known", not "nobody owns a copy".
 */
export function buildNote(entry: HardcoverUserBook, backlog: BacklogInfo | null, ownerName: string): BuiltNote {
	const book = entry.book;
	const author = chooseAuthor(entry);
	const title = chooseTitle(entry);
	const isbn = chooseIsbn(entry);
	const language = chooseLanguage(entry);
	const fiction = chooseFiction(book);
	const owned = entry.owned && ownerName ? ownerName : "";
	const series = pickSeries(book);
	const genre = splitList(backlog?.genre ?? "");
	const labels = splitList(backlog?.labels ?? "").filter((label) => !isOwnedLabel(label));
	const rating10 = toRating10(entry.rating);
	const dateRead = entry.status_id === 3 ? entry.first_read_date ?? "" : "";
	const goodreadsId = backlog?.goodreadsId ? goodreadsBookUrl(backlog.goodreadsId) : "";

	const field = (key: string, value: string | number | null | undefined) => (value === null || value === undefined || value === "" ? `${key}:\n` : `${key}: ${value}\n`);
	const seriesBlock = series
		? field("series", yamlScalar(series.name)) + field("series_position", series.position) + field("series_total", series.total)
		: "";

	const text =
		"---\n" +
		field("author", yamlScalar(author)) +
		field("title", yamlScalar(title)) +
		field("pages", choosePages(entry)) +
		field("cover", chooseCover(entry)) +
		field("dateRead", dateRead) +
		field("dateStarted", entry.first_started_reading_date) +
		field("isbn", isbn ? `"${isbn}"` : "") +
		field("datePublished", book.release_date) +
		field("goodreads_id", goodreadsId) +
		field("hardcover_id", entry.book_id) +
		field("hardcover_link", hardcoverBookUrl(book.slug)) +
		seriesBlock +
		renderList("genre", genre.map((g) => yamlScalar(g)), LABELS_STYLE) +
		renderList("labels", labels, LABELS_STYLE) +
		field("rating_10", rating10) +
		field("language_read", language) +
		renderList("owned", owned ? [owned] : [], OWNED_STYLE) +
		field("fiction", fiction) +
		"medium:\n" +
		"rereads: []\n" +
		"---\n" +
		`# ${title}\n` +
		`author: [[${author}]]\n` +
		"\n---\n" +
		`${(book.description ?? "").trim()}\n` +
		"\n---\n" +
		"find all books in [[../List of books]]\n";

	const stillNeeded = ["medium"];
	if (!owned) stillNeeded.push("owned");
	if (labels.length === 0) stillNeeded.push("labels");
	if (!fiction) stillNeeded.push("fiction");
	if (!language) stillNeeded.push("language_read");
	if (entry.status_id === 3 && rating10 === null) stillNeeded.push("rating_10");
	if (!goodreadsId) stillNeeded.push("goodreads_id");
	const noEdition = entry.edition === null;
	if (noEdition) stillNeeded.push("edition (none picked on Hardcover)");

	return { text, filename: noteFilename(author, title), author, title, series, stillNeeded, noEdition };
}
