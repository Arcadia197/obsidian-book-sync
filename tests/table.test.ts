import { test } from "node:test";
import { strict as assert } from "node:assert";
import { addRow, parseTable, serializeTable, setCell, sortRowsDesc, splitList, splitRow } from "../src/core/table";
import { extractId } from "../src/core/idLinks";

const HEADER = "| Title | Author | DateAdded | Genre | Labels | Notes | isbn | goodreads_id | hardcover_id |";
const SEP = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
const ROW_A = "| Book A | Ann Author | 2026-01-02 |  | Sci-Fi, french | rec by a friend | 0123456789 | [111](https://www.goodreads.com/book/show/111) | [9001](https://hardcover.app/books/book-a) |";
const ROW_B = "| Book B | Ben Writer | 2025-05-05 |  |  |  |  | [222](https://www.goodreads.com/book/show/222) |  |";
const FILE = ["---", "cssclasses:", "  - wide", "---", "#books", "", "> [!note]- How to edit", "> | not a table, a callout line", "", HEADER, SEP, ROW_A, ROW_B, ""].join("\n");

test("splitRow: outer pipes dropped, cells trimmed, empty cells kept", () => {
	assert.deepEqual(splitRow("| a |  | c |"), ["a", "", "c"]);
	assert.deepEqual(splitRow("|a|b|"), ["a", "b"]);
});

test("splitRow: an escaped pipe stays inside its cell", () => {
	assert.deepEqual(splitRow("| A \\| B | x |"), ["A \\| B", "x"]);
});

test("parseTable: finds the header by marker, skips the callout, reads cells by header name", () => {
	const table = parseTable(FILE, "Title")!;
	assert.equal(table.header.length, 9);
	assert.equal(table.rows.length, 2);
	assert.equal(table.rows[0].cells.isbn, "0123456789");
	assert.equal(extractId(table.rows[0].cells.goodreads_id), "111");
	assert.equal(parseTable("no table here", "Title"), null);
});

test("round trip: parse + serialize gives the file back byte for byte", () => {
	assert.equal(serializeTable(parseTable(FILE, "Title")!), FILE);
	const noFinalNewline = FILE.replace(/\n$/, "");
	assert.equal(serializeTable(parseTable(noFinalNewline, "Title")!), noFinalNewline);
});

test("regression: columns come from the header, so a reordered table keeps every column (isbn once got dropped)", () => {
	const reordered = ["| isbn | Title | goodreads_id | Notes |", "| --- | --- | --- | --- |", "| 999 | Old | [1](u) | n |"].join("\n");
	const table = parseTable(reordered, "Title")!;
	setCell(table, table.rows[0], "Notes", "changed");
	addRow(table, { Title: "New", isbn: "123" });
	assert.equal(serializeTable(table), ["| isbn | Title | goodreads_id | Notes |", "| --- | --- | --- | --- |", "| 999 | Old | [1](u) | changed |", "| 123 | New |  |  |"].join("\n"));
});

test("setCell: only the edited row is re-rendered, other rows keep their exact text", () => {
	const oddSpacing = FILE.replace(ROW_B, "|Book B|Ben Writer|2025-05-05||||| [222](https://www.goodreads.com/book/show/222) | |");
	const table = parseTable(oddSpacing, "Title")!;
	setCell(table, table.rows[0], "Labels", "Sci-Fi");
	const out = serializeTable(table);
	assert.ok(out.includes("|Book B|Ben Writer|2025-05-05|||||"), "untouched row kept verbatim");
	assert.ok(out.includes("| Book A | Ann Author | 2026-01-02 |  | Sci-Fi | rec by a friend |"));
});

test("setCell: same value is a no-op, the row keeps its original line", () => {
	const table = parseTable(FILE, "Title")!;
	setCell(table, table.rows[0], "Title", "Book A");
	assert.equal(table.rows[0].original, ROW_A);
});

test("setCell: a value with | or a line break can't break the row", () => {
	const table = parseTable(FILE, "Title")!;
	setCell(table, table.rows[1], "Title", "Either | Or\nPart 2");
	const reparsed = parseTable(serializeTable(table), "Title")!;
	assert.equal(reparsed.rows[1].malformed, false);
	assert.equal(reparsed.rows[1].cells.Title, "Either \\| Or Part 2");
	assert.equal(reparsed.rows[1].cells.Author, "Ben Writer");
});

test("regression: a stray | in Notes marks the row malformed; it survives a rewrite verbatim and can't be edited", () => {
	const stray = "| Book C | Cy | 2024-01-01 |  |  | owned by me | and Klara |  | [333](https://www.goodreads.com/book/show/333) |  |";
	const file = FILE.replace(ROW_B, `${ROW_B}\n${stray}`);
	const table = parseTable(file, "Title")!;
	const row = table.rows[2];
	assert.equal(row.malformed, true);
	assert.throws(() => setCell(table, row, "Labels", "x"), /cell count/);
	setCell(table, table.rows[0], "Labels", "Fantasy");
	sortRowsDesc(table, "DateAdded");
	assert.ok(serializeTable(table).includes(stray));
});

test("regression: a row with a blank goodreads_id survives a sort + full rewrite", () => {
	const handInserted = "| Hand Added | Hana |  |  |  | started without a Goodreads entry |  |  | [77](https://hardcover.app/books/hand) |";
	const table = parseTable(FILE.replace(ROW_B, `${ROW_B}\n${handInserted}`), "Title")!;
	addRow(table, { Title: "Newest", DateAdded: "2026-09-30", goodreads_id: "[444](https://www.goodreads.com/book/show/444)" });
	sortRowsDesc(table, "DateAdded");
	const out = serializeTable(table);
	assert.ok(out.includes(handInserted));
	assert.deepEqual(parseTable(out, "Title")!.rows.map((r) => r.cells.Title), ["Newest", "Book A", "Book B", "Hand Added"]);
});

test("sortRowsDesc: newest first, ties keep their order (like Python's stable sort with reverse=True)", () => {
	const table = parseTable(FILE, "Title")!;
	addRow(table, { Title: "Tie 1", DateAdded: "2025-05-05" });
	addRow(table, { Title: "Tie 2", DateAdded: "2025-05-05" });
	sortRowsDesc(table, "DateAdded");
	assert.deepEqual(table.rows.map((r) => r.cells.Title), ["Book A", "Book B", "Tie 1", "Tie 2"]);
});

test("setCell: unknown column throws instead of silently writing nowhere", () => {
	const table = parseTable(FILE, "Title")!;
	assert.throws(() => setCell(table, table.rows[0], "Rating", "5"), /no "Rating" column/);
});

test("splitList: comma-separated, blanks dropped", () => {
	assert.deepEqual(splitList(" Sci-Fi, ,french ,"), ["Sci-Fi", "french"]);
	assert.deepEqual(splitList(""), []);
});
