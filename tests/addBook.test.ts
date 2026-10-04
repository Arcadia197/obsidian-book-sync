import { test } from "node:test";
import { strict as assert } from "node:assert";
import { localDate, planAddBook } from "../src/steps/addBook";
import { STEPS } from "../src/steps";
import { selectedChanges } from "../src/core/changes";
import { parseTable } from "../src/core/table";
import { MemoryVault } from "./memoryVault";
import { BACKLOG, backlogFile, context, noteText, notePath, row } from "./stepFixtures";

const PAGE = { title: "Off Shelf", author: "Ola", isbn: "0000000077" };

function setup() {
	return new MemoryVault({
		[BACKLOG]: backlogFile([row({ title: "Known", author: "Kay", date: "2026-03-01", gr: "10" })]),
		[notePath("Archived", "Ada")]: noteText({ title: "Archived", author: "Ada", hc: 1, gr: "40", labels: ["Sci-Fi", "classics"] }),
	});
}

test("addBook: the book page becomes one ticked row change, DateAdded today, labels suggested from the vocabulary", async () => {
	const vault = setup();
	const fetched: string[] = [];
	const ctx = context(vault, {
		settings: { openaiKey: "key" },
		goodreads: { fetchBook: async (id) => (fetched.push(id), PAGE) },
		openai: { proposeLabels: async () => ({ "77": ["classics"] }) },
	});
	const plan = await planAddBook(ctx, "https://www.goodreads.com/book/show/77.Off_Shelf", "2026-10-05");
	assert.deepEqual(fetched, ["77"]);
	assert.equal(plan.step, "backlog/addBook");
	assert.deepEqual(plan.changes.map((c) => [c.id, c.selected, c.input?.value]), [["add:77", true, "classics"]]);
	assert.deepEqual(plan.changes[0].input?.options, ["Sci-Fi", "classics"]);
	assert.equal(vault.writes.length, 0, "plan never writes");

	const result = await STEPS["backlog/addBook"].apply(ctx.apply, selectedChanges(plan));
	assert.deepEqual(result.applied, ["add:77"]);
	const rows = parseTable(vault.files.get(BACKLOG)!, "Title")!.rows.map((r) => r.cells);
	assert.deepEqual(
		[rows[0].Title, rows[0].Author, rows[0].DateAdded, rows[0].Labels, rows[0].isbn, rows[0].goodreads_id, rows[0].hardcover_id],
		["Off Shelf", "Ola", "2026-10-05", "classics", "0000000077", "[77](https://www.goodreads.com/book/show/77)", ""],
	);
	const again = await STEPS["backlog/addBook"].apply(ctx.apply, selectedChanges(plan));
	assert.deepEqual(again.skipped, [{ id: "add:77", reason: "already in the table" }], "a second apply adds no duplicate");
});

test("addBook: a book already in the backlog or archived is refused before any request", async () => {
	const vault = setup();
	const ctx = context(vault);
	const inBacklog = await planAddBook(ctx, "10");
	assert.equal(inBacklog.changes.length, 0);
	assert.match(inBacklog.notes.join(), /Already in Want to Read: Known \(Kay\)/);
	const archived = await planAddBook(ctx, "goodreads.com/book/show/40");
	assert.equal(archived.changes.length, 0);
	assert.match(archived.notes.join(), /Already archived: Ada - Archived\.md/);
});

test("addBook: input without a Goodreads id is a clear error; no key means no suggestion, said in the notes", async () => {
	const ctx = context(setup(), { settings: { openaiKey: "" }, goodreads: { fetchBook: async () => PAGE } });
	await assert.rejects(planAddBook(ctx, "the overstory"), /No Goodreads book id in "the overstory"/);
	const plan = await planAddBook(ctx, "77");
	assert.equal(plan.changes[0].input?.value, "");
	assert.match(plan.notes.join("\n"), /No OpenAI API key set/);
});

test("localDate: local calendar date, zero-padded", () => {
	assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});
