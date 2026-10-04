// Goodreads and Hardcover ids and links. Want to Read.md stores id cells as markdown links (`[26326](url)`) so a
// click opens the book; Database/ notes store goodreads_id as a bare URL. Port of scripts/id_links.py.

export const goodreadsBookUrl = (id: string) => `https://www.goodreads.com/book/show/${id}`;
export const hardcoverBookUrl = (slug: string) => `https://hardcover.app/books/${slug}`;
export const hardcoverListUrl = (slug: string) => `https://hardcover.app/lists/${slug}`;

const LINK_RE = /^\[(\d+)\]\(.*\)$/;
const HARDCOVER_LINK_RE = /^\[(\d+)\]\(https:\/\/hardcover\.app\/books\/([^)]+)\)$/;
const HARDCOVER_LIST_LINK_RE = /^\[(\d+)\]\(https:\/\/hardcover\.app\/lists\/([^)]+)\)$/;
const GOODREADS_URL_RE = /goodreads\.com\/book\/show\/(\d+)/;
const HARDCOVER_BOOK_URL_RE = /hardcover\.app\/books\/([^/?#]+)/;

/** The numeric id in a `[id](url)` cell, or the trimmed cell itself (a bare id, blank, or anything else). For matching, never for display */
export function extractId(cell: string): string {
	const trimmed = cell.trim();
	return LINK_RE.exec(trimmed)?.[1] ?? trimmed;
}

/** The book slug in a `[id](https://hardcover.app/books/slug)` cell, or null */
export function extractHardcoverSlug(cell: string): string | null {
	return HARDCOVER_LINK_RE.exec(cell.trim())?.[2] ?? null;
}

/** The list slug in a `[id](https://hardcover.app/lists/slug)` cell, or null */
export function extractHardcoverListSlug(cell: string): string | null {
	return HARDCOVER_LIST_LINK_RE.exec(cell.trim())?.[2] ?? null;
}

export function goodreadsLink(id: string | number | null | undefined): string {
	return id ? `[${id}](${goodreadsBookUrl(String(id))})` : "";
}

export function hardcoverLink(id: string | number | null | undefined, slug: string | null | undefined): string {
	return id && slug ? `[${id}](${hardcoverBookUrl(slug)})` : "";
}

export function hardcoverListLink(id: string | number | null | undefined, slug: string | null | undefined): string {
	return id && slug ? `[${id}](${hardcoverListUrl(slug)})` : "";
}

/** The Goodreads book id inside any text holding a book URL (a note's goodreads_id, a pasted link), or null */
export function goodreadsIdFromUrl(text: string): string | null {
	return GOODREADS_URL_RE.exec(text)?.[1] ?? null;
}

/** A Goodreads book id from a URL or a bare id, or null if neither */
export function parseGoodreadsId(idOrUrl: string): string | null {
	const fromUrl = goodreadsIdFromUrl(idOrUrl);
	if (fromUrl) {
		return fromUrl;
	}
	const trimmed = idOrUrl.trim();
	return /^\d+$/.test(trimmed) ? trimmed : null;
}

/** The book slug from a hardcover.app book URL, or the input itself treated as a slug */
export function parseHardcoverSlug(urlOrSlug: string): string {
	return HARDCOVER_BOOK_URL_RE.exec(urlOrSlug)?.[1] ?? urlOrSlug.trim().replace(/^\/+|\/+$/g, "");
}
