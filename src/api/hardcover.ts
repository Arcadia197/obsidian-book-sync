// Hardcover GraphQL client. Port of the request code in scripts/hardcover_merges.py, link_hardcover_ids.py,
// get_hardcover_id.py, push_want_to_read_to_hardcover.py, sync_hardcover_labels.py, promote_from_hardcover.py and
// check_finished_from_hardcover.py.
//
// Reading and writing are two objects: plan() gets a HardcoverReader, which has no mutate() at all and refuses a
// mutation sent through query(), so a dry run can't write by construction. Only apply() gets a HardcoverWriter.
// Both share one transport, so pacing holds across them.
//
// The API is beta. Schema facts below cite the docs page (mirror: github.com/hardcoverapp/hardcover-docs,
// src/content/docs/api/...) and were checked live with read-only queries and introspection on 2026-10-04.

import type { HardcoverContribution, HardcoverUserBook } from "../core/hardcoverTypes";
import { ApiError, Clock, HttpFn, Pacer, realClock, retryAfterSeconds, snippet, withTimeout } from "./http";

export const HARDCOVER_ENDPOINT = "https://api.hardcover.app/v1/graphql";

// Getting-Started.mdx "Rate Limits": free plan 60 per minute, burst 10, and every top-level field of a request
// counts as one. 1.1s per field keeps a long run under 60/min, like the Python's REQUEST_INTERVAL_SECONDS
const INTERVAL_MS = 1100;
const MAX_ATTEMPTS = 5;
// Getting-Started.mdx "Limitations": queries time out on Hardcover's side after 30s
const TIMEOUT_MS = 35_000;

export interface HardcoverOptions {
	token: string;
	http: HttpFn;
	endpoint?: string;
	clock?: Clock;
	intervalMs?: number;
	timeoutMs?: number;
}

/** A book id with the slug its hardcover.app URL needs */
export interface BookRef {
	id: number;
	slug: string;
}

/** `book` only when the isbn points at exactly one book; otherwise how many distinct books it matched */
export type IsbnMatch = { book: BookRef; count: 1 } | { book: null; count: number };

export interface TrackedBook {
	book_id: number;
	status_id: number;
	book: { title: string; contributions: HardcoverContribution[] };
}

export interface BookStatus {
	book_id: number;
	status_id: number;
}

export interface FinishedInfo {
	book_id: number;
	status_id: number;
	/** 0-5 in halves */
	rating: number | null;
	review: string | null;
	first_read_date: string | null;
}

export interface HardcoverList {
	id: number;
	name: string;
	slug: string;
}

/** The result of insert_user_book: `error` is Hardcover's own message when it refused */
export interface InsertResult {
	id: number | null;
	error: string | null;
}

function isMutation(document: string): boolean {
	return /^(\s|#[^\n]*\n)*mutation\b/.test(document);
}

/** Digits-only ids, deduplicated and sorted, as numbers */
function bookIds(ids: Iterable<string | number>): number[] {
	const unique = new Set<number>();
	for (const id of ids) {
		const text = String(id).trim();
		if (/^\d+$/.test(text)) {
			unique.add(Number(text));
		}
	}
	return [...unique].sort((a, b) => a - b);
}

class Transport {
	private readonly pacer: Pacer;
	private readonly endpoint: string;
	private readonly clock: Clock;
	private readonly timeoutMs: number;

	constructor(private readonly options: HardcoverOptions) {
		this.endpoint = options.endpoint ?? HARDCOVER_ENDPOINT;
		this.clock = options.clock ?? realClock;
		this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
		this.pacer = new Pacer(options.intervalMs ?? INTERVAL_MS, this.clock);
	}

	/** `cost`: top-level fields in the document, each counts against the rate limit */
	async send<T>(document: string, variables: Record<string, unknown>, cost: number): Promise<T> {
		if (!this.options.token) {
			throw new ApiError("No Hardcover API token set. Add it in the plugin settings.");
		}
		const body = JSON.stringify({ query: document, variables });
		for (let attempt = 1; ; attempt++) {
			await this.pacer.wait(cost);
			const response = await withTimeout(
				this.options.http({
					url: this.endpoint,
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.options.token}`,
						"Content-Type": "application/json",
						// Getting-Started.mdx recommends a user agent describing the script
						"User-Agent": "obsidian-book-sync (Obsidian plugin)",
					},
					body,
				}),
				this.timeoutMs,
				"Hardcover",
			);
			// Getting-Started.mdx "API Response Codes": 429 rate limited, 503 "temporarily unavailable, safe to
			// retry". Both mean nothing ran, so a retry can't double a write
			if ((response.status === 429 || response.status === 503) && attempt < MAX_ATTEMPTS) {
				const wait = retryAfterSeconds(response) ?? 5 * attempt;
				await this.clock.sleep(wait * 1000);
				continue;
			}
			if (response.status === 401) {
				throw new ApiError("Hardcover rejected the API token (HTTP 401). Check it in the plugin settings.", 401);
			}
			if (response.status < 200 || response.status >= 300) {
				throw new ApiError(`Hardcover answered HTTP ${response.status}: ${snippet(response.text)}`, response.status);
			}
			let payload: { data?: T; errors?: { message?: string }[] };
			try {
				payload = JSON.parse(response.text);
			} catch {
				throw new ApiError(`Hardcover answered with something that isn't JSON: ${snippet(response.text)}`, response.status);
			}
			if (payload.errors?.length) {
				const messages = payload.errors.map((e) => e.message ?? JSON.stringify(e)).join("; ");
				throw new ApiError(`Hardcover API error: ${messages}`, response.status);
			}
			if (!payload.data) {
				throw new ApiError(`Hardcover answered without data: ${snippet(response.text)}`, response.status);
			}
			return payload.data;
		}
	}
}

export interface ShelfEdition {
	/** The edition on your shelf; null until Hardcover or you set one */
	edition: number | null;
	/** The book's default editions (physical, ebook, audio, cover) */
	defaults: number[];
}

/** Read-only access. Has no mutate(), and query() refuses mutations */
export class HardcoverReader {
	/** @internal */
	constructor(protected readonly transport: Transport) {}

	/** A GraphQL query; `cost` is its number of top-level fields */
	async query<T>(document: string, variables: Record<string, unknown> = {}, cost = 1): Promise<T> {
		if (isMutation(document)) {
			throw new ApiError("Refusing to send a mutation through the read-only Hardcover client.");
		}
		return this.transport.send<T>(document, variables, cost);
	}

	/** `me` is a one-element list holding the token's user (Schemas/Users.mdx) */
	private async me<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
		const data = await this.query<{ me: T[] }>(document, variables);
		if (!data.me?.length) {
			throw new ApiError("Hardcover returned no user for this API token.");
		}
		return data.me[0];
	}

	/** The username behind the token (the settings' Test button) */
	async whoAmI(): Promise<string> {
		const me = await this.me<{ username: string }>(`query WhoAmI { me { username } }`);
		return me.username;
	}

	/**
	 * The book an isbn belongs to, tried as isbn_10 and isbn_13 (Goodreads doesn't say which it gave us). Only a
	 * single distinct book counts as a match: a wrong id is worse than a missing one. Port of link_hardcover_ids.py
	 */
	async lookupIsbn(isbn: string): Promise<IsbnMatch> {
		// Schemas/Editions.mdx: editions have isbn_10, isbn_13 and book_id
		const data = await this.query<Record<"by_10" | "by_13", { book_id: number; book: { slug: string } }[]>>(
			`query GetEditionByISBN($isbn: String!) {
				by_10: editions(where: {isbn_10: {_eq: $isbn}}) { book_id book { slug } }
				by_13: editions(where: {isbn_13: {_eq: $isbn}}) { book_id book { slug } }
			}`,
			{ isbn },
			2,
		);
		const slugs = new Map<number, string>();
		for (const edition of [...data.by_10, ...data.by_13]) {
			slugs.set(edition.book_id, edition.book.slug);
		}
		if (slugs.size === 1) {
			const [[id, slug]] = slugs;
			return { book: { id, slug }, count: 1 };
		}
		return { book: null, count: slugs.size };
	}

	/** Books with this slug (normally one). Port of get_hardcover_id.py */
	async booksBySlug(slug: string): Promise<{ id: number; title: string }[]> {
		const data = await this.query<{ books: { id: number; title: string }[] }>(
			`query GetBookBySlug($slug: String!) { books(where: {slug: {_eq: $slug}}) { id title } }`,
			{ slug },
		);
		return data.books;
	}

	/**
	 * Old id -> the book Hardcover merged it into, for every id that is the losing side of a merge. Unmerged or
	 * unknown ids are absent. Port of hardcover_merges.py.
	 * Schemas/Books.mdx: `canonical_id` is set only on a duplicate, `canonical` is the book it points to
	 */
	async resolveMerges(ids: Iterable<string | number>): Promise<Map<string, BookRef>> {
		const merges = new Map<string, BookRef>();
		const wanted = bookIds(ids);
		if (!wanted.length) {
			return merges;
		}
		const data = await this.query<{ books: { id: number; canonical_id: number | null; canonical: { slug: string } | null }[] }>(
			`query ResolveMerges($ids: [Int!]!) { books(where: {id: {_in: $ids}}) { id canonical_id canonical { slug } } }`,
			{ ids: wanted },
		);
		for (const book of data.books) {
			if (book.canonical_id && book.canonical_id !== book.id && book.canonical) {
				merges.set(String(book.id), { id: book.canonical_id, slug: book.canonical.slug });
			}
		}
		return merges;
	}

	/** Every book on the user's shelves, any status, with title and credits for the duplicate check (push) */
	async trackedBooks(): Promise<TrackedBook[]> {
		// Schemas/UserBooks.mdx: status_id 1 Want to Read, 2 Currently Reading, 3 Read, 4 Paused, 5 DNF, 6 Ignored
		const me = await this.me<{ user_books: TrackedBook[] }>(
			`{ me { user_books { book_id status_id book { title contributions { contribution author { name } } } } } }`,
		);
		return me.user_books;
	}

	/**
	 * Book id and status of every Currently Reading or Read book. Cheap on purpose: the nested detail shape for
	 * ~165 books timed out, so details are fetched only for candidates (promote_from_hardcover.py)
	 */
	async readingStatuses(): Promise<BookStatus[]> {
		const me = await this.me<{ user_books: BookStatus[] }>(
			`{ me { user_books(where: {status_id: {_in: [2, 3]}}) { book_id status_id } } }`,
		);
		return me.user_books;
	}

	/** Everything a new Database/ note needs, for these Currently Reading or Read books only */
	async userBookDetails(ids: Iterable<string | number>): Promise<HardcoverUserBook[]> {
		const wanted = bookIds(ids);
		if (!wanted.length) {
			return [];
		}
		// Shape of promote_from_hardcover.py DETAIL_QUERY; fields as in core/hardcoverTypes.ts
		const me = await this.me<{ user_books: HardcoverUserBook[] }>(
			`query UserBookDetails($ids: [Int!]!) { me { user_books(where: {status_id: {_in: [2, 3]}, book_id: {_in: $ids}}) {
				book_id status_id rating owned first_started_reading_date first_read_date
				edition {
					title isbn_10 isbn_13 pages image { url } language { language }
					contributions { contribution author { name } }
				}
				book {
					title slug pages description release_date literary_type_id image { url }
					contributions { contribution author { name } }
					featured_book_series { position series { name primary_books_count books_count } }
					book_series { featured position series { name primary_books_count books_count } }
				}
			} } }`,
			{ ids: wanted },
		);
		return me.user_books;
	}

	/**
	 * Of these books, the ones on your shelves (any status, the map's keys) with their edition and the book's default
	 * editions ("Left for you"). A book added without an edition gets a default one from Hardcover within a second
	 * (seen 2026-10-05), so a set edition alone doesn't mean you picked it
	 */
	async shelfEditions(ids: Iterable<string | number>): Promise<Map<number, ShelfEdition>> {
		const wanted = bookIds(ids);
		if (!wanted.length) {
			return new Map();
		}
		type Defaults = Record<"default_physical_edition_id" | "default_ebook_edition_id" | "default_audio_edition_id" | "default_cover_edition_id", number | null>;
		const me = await this.me<{ user_books: { book_id: number; edition_id: number | null; book: Defaults | null }[] }>(
			`query ShelfEditions($ids: [Int!]!) { me { user_books(where: {book_id: {_in: $ids}}) { book_id edition_id ` +
				`book { default_physical_edition_id default_ebook_edition_id default_audio_edition_id default_cover_edition_id } } } }`,
			{ ids: wanted },
		);
		return new Map(
			me.user_books.map((u) => [
				u.book_id,
				{ edition: u.edition_id, defaults: [...new Set(Object.values(u.book ?? {}).filter((id): id is number => typeof id === "number"))] },
			]),
		);
	}

	/** Status, rating, review and finish date for these books, any status (check_finished_from_hardcover.py) */
	async finishedInfo(ids: Iterable<string | number>): Promise<FinishedInfo[]> {
		const wanted = bookIds(ids);
		if (!wanted.length) {
			return [];
		}
		const me = await this.me<{ user_books: FinishedInfo[] }>(
			`query FinishedInfo($ids: [Int!]!) { me { user_books(where: {book_id: {_in: $ids}}) {
				book_id status_id rating review first_read_date
			} } }`,
			{ ids: wanted },
		);
		return me.user_books;
	}

	/** The user's own lists (Schemas/Lists.mdx) */
	async myLists(): Promise<HardcoverList[]> {
		const me = await this.me<{ lists: HardcoverList[] }>(`{ me { lists { id name slug } } }`);
		return me.lists;
	}

	/**
	 * The user's list with this name, ignoring case, or null. Checked before creating a list: an interrupted run can
	 * leave a list on Hardcover that Hardcover Lists.md never recorded (sync_hardcover_labels.py, 2026-09-23)
	 */
	async listByName(name: string): Promise<HardcoverList | null> {
		const lower = name.trim().toLowerCase();
		return (await this.myLists()).find((list) => list.name.trim().toLowerCase() === lower) ?? null;
	}

	/** Book ids (as strings, like the ids read from files) on a list */
	async listBookIds(listId: number): Promise<Set<string>> {
		const data = await this.query<{ list_books: { book_id: number }[] }>(
			`query GetListBooks($list_id: Int!) { list_books(where: {list_id: {_eq: $list_id}}) { book_id } }`,
			{ list_id: listId },
		);
		return new Set(data.list_books.map((entry) => String(entry.book_id)));
	}

	async listSlug(listId: number): Promise<string | null> {
		const data = await this.query<{ lists: { slug: string }[] }>(
			`query GetListSlug($id: Int!) { lists(where: {id: {_eq: $id}}) { slug } }`,
			{ id: listId },
		);
		return data.lists[0]?.slug ?? null;
	}
}

/** Read and write access, for apply() only */
export class HardcoverWriter extends HardcoverReader {
	/** A GraphQL mutation; anything else is refused so reads stay on query() */
	async mutate<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
		if (!isMutation(document)) {
			throw new ApiError("mutate() only sends mutations; use query() for reads.");
		}
		return this.transport.send<T>(document, variables, 1);
	}

	/**
	 * Adds a book as Want to Read (status 1). Never call it for a book that already has any status: Hardcover owns
	 * status. Sets no edition, like the Python; the caller reminds the user to pick one.
	 * Schemas/UserBooks.mdx; UserBookCreateInput (introspection 2026-10-04) also has `edition_id`, left out on purpose:
	 * the user picks the edition by hand (the backlog's Goodreads isbn is an arbitrary edition)
	 */
	async addWantToRead(bookId: number, dateAdded?: string): Promise<InsertResult> {
		const object: Record<string, unknown> = { book_id: bookId, status_id: 1 };
		if (dateAdded) {
			object.date_added = dateAdded;
		}
		const data = await this.mutate<{ insert_user_book: { id: number | null; error: string | null } }>(
			`mutation InsertUserBook($object: UserBookCreateInput!) { insert_user_book(object: $object) { id error } }`,
			{ object },
		);
		return { id: data.insert_user_book.id ?? null, error: data.insert_user_book.error ?? null };
	}

	/**
	 * Creates a public list (privacy_setting_id 1, as the Python does) and returns its id and slug. insert_list
	 * returns only the id (ListIdType, Schemas/Lists.mdx), so the slug takes a second query
	 */
	async createList(name: string): Promise<HardcoverList> {
		const data = await this.mutate<{ insert_list: { id: number | null; errors: string[] | null } }>(
			`mutation InsertList($object: ListInput!) { insert_list(object: $object) { id errors } }`,
			{ object: { name, privacy_setting_id: 1 } },
		);
		const id = data.insert_list.id;
		if (!id) {
			throw new ApiError(`Hardcover didn't create the list "${name}": ${JSON.stringify(data.insert_list.errors ?? null)}`);
		}
		const slug = await this.listSlug(id);
		if (!slug) {
			throw new ApiError(`Hardcover created the list "${name}" (id ${id}) but returned no slug for it.`);
		}
		return { id, name, slug };
	}

	/** Puts a book on a list (ListBookInput, Schemas/Lists.mdx) */
	async addListBook(listId: number, bookId: number): Promise<void> {
		await this.mutate<{ insert_list_book: { id: number | null } }>(
			`mutation InsertListBook($object: ListBookInput!) { insert_list_book(object: $object) { id } }`,
			{ object: { list_id: listId, book_id: bookId } },
		);
	}
}

/** One transport, two views: give `reader` to plan() and `writer` only to apply() */
export function createHardcover(options: HardcoverOptions): { reader: HardcoverReader; writer: HardcoverWriter } {
	const transport = new Transport(options);
	return { reader: new HardcoverReader(transport), writer: new HardcoverWriter(transport) };
}
