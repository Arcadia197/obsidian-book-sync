// Reading and editing existing Database/ notes (one note per started or finished book).
// `owned` here holds names (`owned: Julius`, or a list for several owners); only the owner name from the settings
// syncs with Hardcover's "owned" list. A literal "owned" inside `labels` is a leftover and gets removed.

import { getField, getList, LABELS_STYLE, OWNED_STYLE, setField, setList, unquote } from "./frontmatter";
import { goodreadsIdFromUrl, hardcoverBookUrl } from "./idLinks";

export const EMBED_LINE = "find all books in [[../List of books]]";
export const REVIEW_HEADER = "## Hardcover review";

export interface DatabaseNote {
	path: string;
	title: string;
	author: string;
	/** Digits only, or null when missing or not a plain number */
	hardcoverId: string | null;
	goodreadsId: string | null;
	/** "" when blank */
	dateRead: string;
	/** As written; null when the note has no `labels` field */
	labels: string[] | null;
	/** Owner names as written; empty when blank or missing */
	owned: string[];
}

function basename(path: string): string {
	return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

export function readDatabaseNote(path: string, text: string): DatabaseNote {
	const hardcoverId = getField(text, "hardcover_id") ?? "";
	return {
		path,
		title: unquote(getField(text, "title") ?? "") || basename(path),
		author: unquote(getField(text, "author") ?? ""),
		hardcoverId: /^\d+$/.test(hardcoverId) ? hardcoverId : null,
		goodreadsId: goodreadsIdFromUrl(getField(text, "goodreads_id") ?? ""),
		dateRead: unquote(getField(text, "dateRead") ?? ""),
		labels: getList(text, "labels"),
		owned: getList(text, "owned") ?? [],
	};
}

/** Case-insensitive, quotes ignored */
export function sameName(a: string, b: string): boolean {
	return unquote(a).toLowerCase() === unquote(b).toLowerCase();
}

export function isOwnedLabel(label: string): boolean {
	return sameName(label, "owned");
}

export function setLabels(text: string, labels: string[]): string {
	return setList(text, "labels", labels, LABELS_STYLE);
}

export function setOwned(text: string, names: string[]): string {
	return setList(text, "owned", names, OWNED_STYLE);
}

/** Points the note at another Hardcover book, e.g. the winner of a merge */
export function setHardcoverId(text: string, id: string | number, slug: string): string {
	return setField(setField(text, "hardcover_id", id), "hardcover_link", hardcoverBookUrl(slug));
}

/** Hardcover's 0-5 (halves) as 0-10, or null without a rating */
export function toRating10(rating: number | null | undefined): number | null {
	return rating === null || rating === undefined ? null : rating * 2;
}

/**
 * A finished book: `dateRead` always (Hardcover wins for dates read), `rating_10` only if Hardcover has a rating,
 * and the Hardcover review as its own section right after the embed line, before any hand-written sections.
 * The review is only added once.
 */
export function applyFinished(text: string, dateRead: string, rating10: number | null, review: string | null | undefined): string {
	let result = setField(text, "dateRead", dateRead);
	if (rating10 !== null) {
		result = setField(result, "rating_10", rating10);
	}
	const reviewText = (review ?? "").trim();
	if (reviewText && !result.includes(REVIEW_HEADER)) {
		const section = `\n${REVIEW_HEADER}\n${reviewText}`;
		result = result.includes(EMBED_LINE)
			? result.replace(EMBED_LINE, () => `${EMBED_LINE}\n${section}`)
			: `${result.replace(/\n+$/, "")}\n${section}`;
	}
	return result;
}

/**
 * Fields still blank that only a human can fill, worth flagging when a book is finished. Not `genre` (empty on
 * purpose since the labels migration) or `series*` (optional). A field that's missing entirely isn't flagged.
 */
export function stillNeededFields(text: string): string[] {
	const blank: string[] = [];
	for (const key of ["medium", "owned", "fiction", "language_read", "labels"]) {
		const values = getList(text, key);
		if (values !== null && values.every((value) => unquote(value) === "")) {
			blank.push(key);
		}
	}
	return blank;
}
