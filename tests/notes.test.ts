import { test } from "node:test";
import { strict as assert } from "node:assert";
import { applyFinished, isOwnedLabel, readDatabaseNote, setHardcoverId, setLabels, setOwned, stillNeededFields, toRating10 } from "../src/core/databaseNote";
import { buildNote, noteFilename, pickSeries, primaryAuthorNames, yamlScalar } from "../src/core/noteBuilder";
import type { HardcoverUserBook } from "../src/core/hardcoverTypes";

const NOTE = [
	"---",
	"author: Ann Author",
	"title: Book A",
	"pages: 200",
	"dateRead:",
	"goodreads_id: https://www.goodreads.com/book/show/111",
	"hardcover_id: 9001",
	"hardcover_link: https://hardcover.app/books/book-a",
	"genre: []",
	"labels:",
	"  - Sci-Fi",
	"  - owned",
	"rating_10:",
	"language_read: French",
	"owned:",
	"fiction: true",
	"medium:",
	"rereads: []",
	"---",
	"# Book A",
	"author: [[Ann Author]]",
	"",
	"---",
	"A description.",
	"",
	"---",
	"find all books in [[../List of books]]",
	"",
	"## Notes",
	"My own thoughts.",
	"",
].join("\n");

test("readDatabaseNote: ids, labels and owners", () => {
	const note = readDatabaseNote("Books/Database/Ann Author - Book A.md", NOTE);
	assert.equal(note.title, "Book A");
	assert.equal(note.hardcoverId, "9001");
	assert.equal(note.goodreadsId, "111");
	assert.equal(note.dateRead, "");
	assert.deepEqual(note.labels, ["Sci-Fi", "owned"]);
	assert.deepEqual(note.owned, []);
	assert.equal(readDatabaseNote("x/Fallback.md", "---\nhardcover_id: abc\n---\n").title, "Fallback");
	assert.equal(readDatabaseNote("x/Fallback.md", "---\nhardcover_id: abc\n---\n").hardcoverId, null);
});

test("regression: owned is a name field in notes; a stray 'owned' label is removed, names keep scalar/list form", () => {
	const note = readDatabaseNote("n.md", NOTE);
	const cleaned = setLabels(NOTE, note.labels!.filter((label) => !isOwnedLabel(label)));
	assert.ok(cleaned.includes("labels:\n  - Sci-Fi\nrating_10:"));
	const withOwner = setOwned(cleaned, ["Klara", "Julius"]);
	assert.ok(withOwner.includes("owned:\n  - Klara\n  - Julius\nfiction:"));
	assert.ok(setOwned(cleaned, ["Julius"]).includes("owned: Julius\nfiction:"));
	assert.equal(isOwnedLabel(' "Owned" '), true);
});

test("setHardcoverId: id and link move together (merged book)", () => {
	const out = setHardcoverId(NOTE, 4242, "book-a-canonical");
	assert.ok(out.includes("hardcover_id: 4242\nhardcover_link: https://hardcover.app/books/book-a-canonical\n"));
});

test("applyFinished: dateRead, rating and the review right after the embed line, before hand-written notes", () => {
	const out = applyFinished(NOTE, "2026-09-28", toRating10(3.5), "  Loved it.  ");
	assert.ok(out.includes("dateRead: 2026-09-28\n"));
	assert.ok(out.includes("rating_10: 7\n"));
	assert.ok(out.includes("find all books in [[../List of books]]\n\n## Hardcover review\nLoved it.\n\n## Notes"));
	assert.equal(applyFinished(out, "2026-09-28", 7, "Loved it."), out, "running it again changes nothing");
});

test("applyFinished: no rating keeps rating_10 blank; no embed line appends the review at the end", () => {
	const noEmbed = NOTE.replace("find all books in [[../List of books]]\n", "");
	const out = applyFinished(noEmbed, "2026-09-28", toRating10(null), "Short.");
	assert.ok(out.includes("rating_10:\n"));
	assert.ok(out.endsWith("My own thoughts.\n\n## Hardcover review\nShort."));
});

test("toRating10: halves to 0-10", () => {
	assert.equal(toRating10(4.5), 9);
	assert.equal(toRating10(0.5), 1);
	assert.equal(toRating10(undefined), null);
});

test("stillNeededFields: blank human fields; a scalar language_read counts as filled", () => {
	assert.deepEqual(stillNeededFields(NOTE), ["medium", "owned"]);
	const multi = NOTE.replace("owned:\n", "owned:\n  - Julius\n  - Klara\n").replace("language_read: French\n", "language_read:\n");
	assert.deepEqual(stillNeededFields(multi), ["medium", "language_read"]);
});

const entry = (overrides: Partial<HardcoverUserBook> = {}): HardcoverUserBook => ({
	book_id: 500,
	status_id: 2,
	rating: null,
	owned: false,
	first_started_reading_date: "2026-09-01",
	first_read_date: null,
	edition: {
		title: "Théorie du Livre",
		isbn_10: "2000000001",
		isbn_13: "9782000000001",
		pages: 158,
		image: { url: "https://assets.example/edition.jpg" },
		language: { language: "French" },
		contributions: [{ contribution: "Author", author: { name: "Vera Writer" } }],
	},
	book: {
		title: "Book Theory",
		slug: "book-theory",
		pages: 200,
		description: "  What it is about.  ",
		release_date: "2006-01-01",
		literary_type_id: 2,
		image: { url: "https://assets.example/book.jpg" },
		contributions: [
			{ contribution: null, author: { name: "Vera Writer" } },
			{ contribution: "Translator", author: { name: "Tom Translator" } },
		],
		featured_book_series: null,
		book_series: [],
	},
	...overrides,
});

test("regression: edition fields come from the user's edition, authors exclude translators", () => {
	const built = buildNote(entry(), { goodreadsId: "777", genre: "", labels: "feminism, owned, french" }, "Julius");
	assert.equal(built.title, "Théorie du Livre");
	assert.equal(built.author, "Vera Writer");
	assert.equal(built.filename, "Vera Writer - Théorie du Livre.md");
	assert.equal(built.text, [
		"---",
		"author: Vera Writer",
		"title: Théorie du Livre",
		"pages: 158",
		"cover: https://assets.example/edition.jpg",
		"dateRead:",
		"dateStarted: 2026-09-01",
		'isbn: "2000000001"',
		"datePublished: 2006-01-01",
		"goodreads_id: https://www.goodreads.com/book/show/777",
		"hardcover_id: 500",
		"hardcover_link: https://hardcover.app/books/book-theory",
		"genre: []",
		"labels:",
		"  - feminism",
		"  - french",
		"rating_10:",
		"language_read: French",
		"owned:",
		"fiction: false",
		"medium:",
		"rereads: []",
		"---",
		"# Théorie du Livre",
		"author: [[Vera Writer]]",
		"",
		"---",
		"What it is about.",
		"",
		"---",
		"find all books in [[../List of books]]",
		"",
	].join("\n"));
	assert.deepEqual(built.stillNeeded, ["medium", "owned"]);
	assert.equal(built.noEdition, false);
});

test("regression: no edition picked (insert_user_book) falls back to the book and is flagged loudly", () => {
	const built = buildNote(entry({ edition: null, status_id: 3, first_read_date: "2026-09-20", owned: true }), null, "Julius");
	assert.equal(built.noEdition, true);
	assert.equal(built.title, "Book Theory");
	assert.equal(built.author, "Vera Writer");
	assert.ok(built.text.includes("pages: 200\ncover: https://assets.example/book.jpg\ndateRead: 2026-09-20\n"));
	assert.ok(built.text.includes("isbn:\n"));
	assert.ok(built.text.includes("owned: Julius\n"));
	assert.deepEqual(built.stillNeeded, ["medium", "labels", "language_read", "rating_10", "goodreads_id", "edition (none picked on Hardcover)"]);
});

test("buildNote: series guess, rating, quoted title with a colon, genre carried over", () => {
	const built = buildNote(entry({
		rating: 4,
		status_id: 3,
		edition: { ...entry().edition!, title: "Saga: Part One" },
		book: { ...entry().book, featured_book_series: { position: 1, series: { name: "The Saga", primary_books_count: 3, books_count: 5 } } },
	}), { goodreadsId: "1", genre: "Essay", labels: "" }, "");
	assert.ok(built.text.includes('title: "Saga: Part One"\n'));
	assert.ok(built.text.includes("hardcover_link: https://hardcover.app/books/book-theory\nseries: The Saga\nseries_position: 1\nseries_total: 3\ngenre:\n  - Essay\nlabels: []\nrating_10: 8\n"));
	assert.equal(built.filename, "Vera Writer - Saga Part One.md");
});

test("pickSeries: featured first, then a series flagged featured, then the first one", () => {
	const s = (name: string) => ({ name, primary_books_count: null, books_count: 4 });
	assert.equal(pickSeries({ ...entry().book, book_series: [{ position: 2, series: s("A") }, { position: 1, featured: true, series: s("B") }] })!.name, "B");
	assert.deepEqual(pickSeries({ ...entry().book, book_series: [{ position: 2, series: s("A") }] }), { name: "A", position: 2, total: 4 });
	assert.equal(pickSeries(entry().book), null);
});

test("primaryAuthorNames: translators only if nobody else is credited", () => {
	assert.equal(primaryAuthorNames([{ contribution: "Translator", author: { name: "T" } }]), "T");
	assert.equal(primaryAuthorNames([{ author: { name: "A" } }, { contribution: "Author", author: { name: "B" } }, { contribution: "Narrator", author: { name: "N" } }]), "A, B");
});

test("yamlScalar and file names", () => {
	assert.equal(yamlScalar("Plain"), "Plain");
	assert.equal(yamlScalar('Say "hi": now'), '"Say \\"hi\\": now"');
	assert.equal(yamlScalar("#1"), '"#1"');
	assert.equal(yamlScalar(null), "");
	assert.equal(noteFilename("A/B", "What? Why: 'Now'"), "AB - What Why Now.md");
});
