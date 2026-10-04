// Shapes of Hardcover GraphQL results the core works with. Field names follow the queries in the Python
// scripts (promote_from_hardcover.py DETAIL_QUERY), checked against the API docs
// (github.com/hardcoverapp/hardcover-docs) and live introspection in 2026-09.

export interface HardcoverContribution {
	/** "Author", "Translator", "Narrator", ... or null/"" for a plain author credit */
	contribution?: string | null;
	author: { name: string };
}

export interface HardcoverSeries {
	name: string;
	primary_books_count?: number | null;
	books_count?: number | null;
}

export interface HardcoverBookSeries {
	position?: number | null;
	featured?: boolean | null;
	series?: HardcoverSeries | null;
}

/** The edition on the user's shelf: title, isbn, cover, pages, language and author come from here */
export interface HardcoverEdition {
	title?: string | null;
	isbn_10?: string | null;
	isbn_13?: string | null;
	pages?: number | null;
	image?: { url: string | null } | null;
	language?: { language: string } | null;
	contributions?: HardcoverContribution[] | null;
}

export interface HardcoverBook {
	title: string;
	slug: string;
	pages?: number | null;
	description?: string | null;
	release_date?: string | null;
	/** 1 = fiction, 2 = non-fiction, null = unclassified */
	literary_type_id?: number | null;
	image?: { url: string | null } | null;
	contributions: HardcoverContribution[];
	featured_book_series?: HardcoverBookSeries | null;
	book_series?: HardcoverBookSeries[] | null;
}

/** One `me.user_books` entry with the details a new Database/ note needs */
export interface HardcoverUserBook {
	book_id: number;
	/** 1 Want to Read, 2 Currently Reading, 3 Read, 4 Paused, 5 DNF, 6 Ignored */
	status_id: number;
	/** 0-5 in halves */
	rating?: number | null;
	owned?: boolean | null;
	first_started_reading_date?: string | null;
	first_read_date?: string | null;
	review?: string | null;
	/** Null when no edition was picked (e.g. the book was added via insert_user_book) */
	edition: HardcoverEdition | null;
	book: HardcoverBook;
}
