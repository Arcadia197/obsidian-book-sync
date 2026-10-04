// Normalized title+author key. Only ever a signal to flag a possible duplicate for review, never to auto-match or
// write: a fuzzy title match is much less certain than an id or isbn match. Port of scripts/title_match.py.

function norm(s: string): string {
	return s
		.toLowerCase()
		.replace(/\(.*?\)/g, "") // series/edition annotations
		.replace(/[^a-z0-9 ]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** `title|first author`, lowercased, ASCII letters and digits only */
export function titleKey(title: string, author: string | null | undefined): string {
	return `${norm(title)}|${norm((author ?? "").split(",")[0])}`;
}
