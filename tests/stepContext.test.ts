import { test } from "node:test";
import { strict as assert } from "node:assert";
import { findRow, loadBacklog, loadNotes, paths, rowGoodreadsId, rowKey } from "../src/steps/context";
import { parseTable, setCell } from "../src/core/table";
import { selectedChanges } from "../src/core/changes";
import { removeRows } from "../src/steps/reconcile";
import { MemoryVault } from "./memoryVault";
import { BACKLOG, backlogFile, DB, noteText, notePath, row, SETTINGS } from "./stepFixtures";

const ROWS = [
	row({ title: "Alpha", author: "Ann", date: "2026-02-01", gr: "11", isbn: "111" }),
	row({ title: "Hand Added", author: "Hal", date: "2026-01-15" }),
	"| Broken | Bo | 2026-01-01 | a | b | c | d | [33](https://www.goodreads.com/book/show/33) |  | extra |",
];

test("paths: every file inside the Books folder", () => {
	assert.deepEqual(paths(SETTINGS), { backlog: "Books/Want to Read.md", lists: "Books/Hardcover Lists.md", database: "Books/Database" });
});

test("rowGoodreadsId: from the cell, from a malformed row's line, null without one", () => {
	const table = parseTable(backlogFile(ROWS), "Title")!;
	assert.deepEqual(table.rows.map(rowGoodreadsId), ["11", null, "33"]);
});

test("findRow: a planned key finds its row again after other rows changed or moved", () => {
	const text = backlogFile(ROWS);
	const planned = parseTable(text, "Title")!;
	const keys = planned.rows.map(rowKey);

	const current = parseTable(text, "Title")!;
	setCell(current, current.rows[0], "Notes", "edited meanwhile");
	current.rows.reverse();
	assert.equal(findRow(current, keys[0])?.cells.Title, "Alpha");
	assert.equal(findRow(current, keys[1])?.cells.Title, "Hand Added");
	assert.equal(findRow(current, keys[2])?.malformed, true);
});

test("findRow: an unkeyed row edited by hand since the plan is not found (never guessed)", () => {
	const planned = parseTable(backlogFile(ROWS), "Title")!;
	const key = rowKey(planned.rows[1]);
	const edited = parseTable(backlogFile([ROWS[0], row({ title: "Hand Added", author: "Hal", date: "2026-01-16" })]), "Title")!;
	assert.equal(findRow(edited, key), null);
});

test("regression: two rows with the same goodreads_id are told apart by their line, never by order", async () => {
	const first = row({ title: "Real Book", author: "Rea", date: "2026-02-01", gr: "1" });
	const twin = row({ title: "Typo Twin", author: "Twi", date: "2026-01-01", gr: "1", hc: [5, "five"] });
	const planned = parseTable(backlogFile([first, twin]), "Title")!;
	const key = rowKey(planned.rows[1]);
	assert.equal(findRow(planned, key)?.cells.Title, "Typo Twin");
	const edited = parseTable(backlogFile([first, row({ title: "Typo Twin", author: "Twi", date: "2026-01-02", gr: "1" })]), "Title")!;
	assert.equal(findRow(edited, key), null, "ambiguous and the planned line is gone: skip");
	const vault = new MemoryVault({ [BACKLOG]: backlogFile([first, twin]) });
	await removeRows(vault, SETTINGS, [key]);
	assert.deepEqual(parseTable(vault.files.get(BACKLOG)!, "Title")!.rows.map((r) => r.original), [first]);
});

test("loadBacklog: clear errors for a missing file or table", async () => {
	await assert.rejects(loadBacklog(new MemoryVault(), SETTINGS), /Want to Read\.md not found/);
	await assert.rejects(loadBacklog(new MemoryVault({ [BACKLOG]: "# no table" }), SETTINGS), /No table with a "Title" column/);
});

test("loadNotes: only .md files directly in the Database folder, sorted by path", async () => {
	const vault = new MemoryVault({
		[notePath("Zeta", "Zed")]: noteText({ title: "Zeta", author: "Zed", hc: 2 }),
		[notePath("Beta", "Bea")]: noteText({ title: "Beta", author: "Bea", hc: 1 }),
		[`${DB}/sub/Nested.md`]: noteText({ title: "Nested", author: "N" }),
		[`${DB}/image.png`]: "",
	});
	const notes = await loadNotes(vault, SETTINGS);
	assert.deepEqual(notes.map((n) => n.note.title), ["Beta", "Zeta"]);
	assert.equal(notes[0].note.hardcoverId, "1");
});

test("selectedChanges: ticked and ready only", () => {
	const base = { summary: "", details: [], warnings: [], writesHardcover: false, payload: null };
	const plan = {
		step: "archive/reconcile" as const,
		notes: [],
		changes: [
			{ ...base, id: "a", selected: true, ready: true },
			{ ...base, id: "b", selected: false, ready: true },
			{ ...base, id: "c", selected: true, ready: false },
		],
	};
	assert.deepEqual(selectedChanges(plan).map((c) => c.id), ["a"]);
});
