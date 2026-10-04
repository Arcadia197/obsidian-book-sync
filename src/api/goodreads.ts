// Goodreads: the to-read shelf as RSS (port of fetch_to_read_entries in scripts/pull_goodreads_to_read.py) and a
// single book page (port of fetch_book in scripts/add_to_want_to_read.py).
//
// The RSS is read with a small extractor instead of an XML parser: DOMParser exists in Obsidian (also on mobile)
// but not in Node tests, and the feed is flat. Each <item> holds its fields once, as plain text, entity-encoded
// text or CDATA (all three seen in a real feed on 2026-10-04).
//
// The RSS URL embeds a private key, so it never goes into an error message.

import { ApiError, Clock, HttpFn, Pacer, realClock, snippet, withTimeout } from "./http";
import { goodreadsBookUrl } from "../core/idLinks";

// add_to_want_to_read.py uses 15s for book pages; the RSS gets the same
const TIMEOUT_MS = 15_000;
// /book/show/ answers an empty 202 to bursts (Akamai bot mitigation), so book pages are spaced out
const BOOK_PAGE_INTERVAL_MS = 2000;

export interface ShelfEntry {
	title: string;
	author: string;
	/** YYYY-MM-DD, the date in the feed's own time zone (as Python's strftime on the parsed date gives it) */
	dateAdded: string;
	isbn: string;
	goodreadsId: string;
}

export interface BookPage {
	title: string;
	author: string;
	/** isbn_10 only, like the Python; "" if the page has none */
	isbn: string;
}

export interface GoodreadsOptions {
	http: HttpFn;
	clock?: Clock;
	timeoutMs?: number;
	bookPageIntervalMs?: number;
	/** Base for book pages; tests point it at a fake server */
	bookUrl?: (id: string) => string;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decodes the XML entities, the common HTML ones and numeric references; unknown names stay as written */
export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
		if (name[0] === "#") {
			const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
			return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		return NAMED_ENTITIES[name.toLowerCase()] ?? match;
	});
}

/** The text of the first `<tag>` in `xml`: CDATA as is, plain text entity-decoded. "" if missing or empty */
function elementText(xml: string, tag: string): string {
	const match = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))\\s*</${tag}>`).exec(xml);
	if (!match) {
		return "";
	}
	return match[1] ?? decodeEntities(match[2]);
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * `Sun, 04 Oct 2026 23:39:25 -0700` -> `2026-10-04`. The date as written, in the feed's own offset: converting
 * through Date would shift a late-evening entry to the next day. Throws on anything else, since DateAdded is
 * always overwritten from Goodreads and a wrong date would replace a right one
 */
export function rssDate(raw: string): string {
	const match = /^\s*(?:[a-z]{3},\s*)?(\d{1,2})\s+([a-z]{3})\s+(\d{4})\s/i.exec(raw);
	const month = match ? MONTHS.indexOf(match[2].toLowerCase()) : -1;
	if (!match || month < 0) {
		throw new ApiError(`Unexpected date in the Goodreads feed: "${raw}"`);
	}
	return `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

/** Every book on the shelf, in feed order */
export function parseShelfRss(xml: string): ShelfEntry[] {
	if (!/<rss[\s>]/.test(xml) || !/<channel[\s>]/.test(xml)) {
		// No body in the message: a login or error page can echo the URL with its key
		throw new ApiError("The Goodreads RSS URL didn't return an RSS feed. Check it in the plugin settings.");
	}
	const entries: ShelfEntry[] = [];
	for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const rawDate = elementText(item, "user_date_added").trim();
		entries.push({
			title: collapse(elementText(item, "title")),
			author: collapse(elementText(item, "author_name")),
			dateAdded: rawDate ? rssDate(rawDate) : "",
			isbn: elementText(item, "isbn").trim(),
			goodreadsId: elementText(item, "book_id").trim(),
		});
	}
	return entries;
}

// The page's JSON-LD block for the book; same pattern as add_to_want_to_read.py's LD_JSON_RE
const LD_JSON_RE = /<script type="application\/ld\+json">(\{.*?"@type":"Book".*?\})<\/script>/;
// isbn_10 sits next to isbn13 in the page's embedded app state
const ISBN10_RE = /"isbn":"([0-9Xx]{10})","isbn13":"\d{13}"/;

/** Title, first author and isbn_10 from a book page's HTML, or null if the page has no book metadata */
export function parseBookPage(html: string): BookPage | null {
	const ld = LD_JSON_RE.exec(html);
	if (!ld) {
		return null;
	}
	let data: { name?: unknown; author?: { name?: unknown }[] };
	try {
		data = JSON.parse(ld[1]);
	} catch {
		return null;
	}
	const firstAuthor = Array.isArray(data.author) ? data.author[0] : undefined;
	return {
		title: decodeEntities(String(data.name ?? "").trim()),
		author: decodeEntities(String(firstAuthor?.name ?? "").trim()),
		isbn: ISBN10_RE.exec(html)?.[1] ?? "",
	};
}

export class GoodreadsClient {
	private readonly clock: Clock;
	private readonly timeoutMs: number;
	private readonly pacer: Pacer;
	private readonly bookUrl: (id: string) => string;

	constructor(private readonly options: GoodreadsOptions) {
		this.clock = options.clock ?? realClock;
		this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
		this.pacer = new Pacer(options.bookPageIntervalMs ?? BOOK_PAGE_INTERVAL_MS, this.clock);
		this.bookUrl = options.bookUrl ?? goodreadsBookUrl;
	}

	/** The shelf behind the RSS URL from the settings (it names the shelf, normally to-read) */
	async fetchShelf(rssUrl: string): Promise<ShelfEntry[]> {
		if (!rssUrl.trim()) {
			throw new ApiError("No Goodreads RSS URL set. Add it in the plugin settings.");
		}
		const response = await withTimeout(this.options.http({ url: rssUrl.trim(), method: "GET" }), this.timeoutMs, "Goodreads");
		if (response.status !== 200) {
			// No URL and no body in the message: both can carry the private key
			throw new ApiError(`Goodreads answered HTTP ${response.status} for the RSS feed. Check the RSS URL in the plugin settings.`, response.status);
		}
		return parseShelfRss(response.text);
	}

	/** One book page by Goodreads id; it doesn't need to be on any shelf */
	async fetchBook(goodreadsId: string): Promise<BookPage> {
		await this.pacer.wait();
		const response = await withTimeout(
			this.options.http({ url: this.bookUrl(goodreadsId), method: "GET", headers: { "User-Agent": "Mozilla/5.0" } }),
			this.timeoutMs,
			"Goodreads",
		);
		if (response.status === 202) {
			throw new ApiError(
				`Goodreads answered HTTP 202 for book ${goodreadsId}: its bot protection after a burst of requests, not a real page. Wait a minute or two and try again.`,
				202,
			);
		}
		if (response.status !== 200) {
			throw new ApiError(`Goodreads answered HTTP ${response.status} for book ${goodreadsId}.`, response.status);
		}
		const book = parseBookPage(response.text);
		if (!book) {
			throw new ApiError(`No book metadata found on the Goodreads page for book ${goodreadsId}.`, response.status);
		}
		return book;
	}
}
