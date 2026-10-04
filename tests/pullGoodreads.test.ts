import { test } from "node:test";
import { strict as assert } from "node:assert";
import { applyPull, planPull, refinePullLabels, vocabularyLabels } from "../src/steps/pullGoodreads";
import { selectedChanges } from "../src/core/changes";
import { parseTable } from "../src/core/table";
import type { ShelfEntry } from "../src/api/goodreads";
import { MemoryVault } from "./memoryVault";
import { BACKLOG, backlogFile, context, LISTS, noteText, notePath, row, SETTINGS } from "./stepFixtures";

const shelf = (id: string, title: string, date: string, isbn = "", author = "Writer"): ShelfEntry => ({ goodreadsId: id, title, author, dateAdded: date, isbn });

const EXISTING = row({ title: "Known", author: "Kay", date: "2026-03-01", genre: "Essay", labels: "classics", notes: "from Lea", gr: "10", hc: [900, "known"] });
const BLANKS = row({ author: "", date: "2025-01-01", gr: "20" });
const HAND = row({ title: "Hand Added", author: "Hal", date: "2026-02-15", notes: "no id yet" });
const MALFORMED = "| Odd \\| one | Oz | 2025-06-01 |  |  | a | stray | 3 | [30](https://www.goodreads.com/book/show/30) |  |";

function setup(rows = [EXISTING, HAND, BLANKS]) {
	return new MemoryVault({
		[BACKLOG]: backlogFile(rows),
		[notePath("Archived", "Ada")]: noteText({ title: "Archived", author: "Ada", hc: 1, gr: "40", labels: ["Sci-Fi", "classics"] }),
		[notePath("Other", "Oli")]: noteText({ title: "Other", author: "Oli", hc: 2, labels: ["essays"] }),
	});
}

const FEED = [
	shelf("50", "Brand New", "2026-04-01", "0000000050", "Nia"),
	shelf("10", "Known (Retitled)", "2026-03-05", "0000000010"),
	shelf("20", "Blank Filled", "2025-01-01", "0000000020", "Bea"),
	shelf("40", "Archived", "2024-01-01"),
];

test("plan: new book, fill-if-blank update, DateAdded refresh, archived and unkeyed rows reported", async () => {
	const vault = setup();
	const plan = await planPull(context(vault, { goodreads: { fetchShelf: async () => FEED } }), { labelSuggestions: false });
	assert.deepEqual(plan.changes.map((c) => c.id), ["add:50", "update:10", "update:20"]);
	assert.deepEqual(plan.changes[1].details, ["isbn: (blank) -> 0000000010", "DateAdded: 2026-03-01 -> 2026-03-05"]);
	assert.deepEqual(plan.changes[2].details, ["Title: (blank) -> Blank Filled", "Author: (blank) -> Bea", "isbn: (blank) -> 0000000020"]);
	assert.ok(plan.changes.every((c) => c.selected && c.ready && !c.writesHardcover));
	assert.match(plan.notes[0], /Found 4 books.*1 are new; 2 already/);
	assert.ok(plan.notes.some((n) => n.includes("Archived (Writer)")));
	assert.ok(plan.notes.some((n) => n.includes("Hand Added (Hal)")));
	assert.equal(vault.writes.length, 0, "plan never writes");
});

test("apply: hand-owned columns untouched, unkeyed row kept, table sorted newest first, rest of the file intact", async () => {
	const vault = setup();
	const ctx = context(vault, { goodreads: { fetchShelf: async () => FEED } });
	const plan = await planPull(ctx, { labelSuggestions: false });
	const result = await applyPull(ctx, selectedChanges(plan));
	assert.deepEqual(result.applied, ["add:50", "update:10", "update:20"]);
	const text = vault.files.get(BACKLOG)!;
	const table = parseTable(text, "Title")!;
	assert.deepEqual(table.rows.map((r) => r.cells.Title), ["Brand New", "Known", "Hand Added", "Blank Filled"]);
	const known = table.rows[1].cells;
	assert.equal(known.Title, "Known", "a filled Title is never overwritten");
	assert.deepEqual([known.Genre, known.Labels, known.Notes, known.DateAdded], ["Essay", "classics", "from Lea", "2026-03-05"]);
	assert.equal(known.hardcover_id, "[900](https://hardcover.app/books/known)");
	assert.equal(table.rows[2].original, HAND, "the unkeyed row is kept byte for byte");
	assert.equal(table.rows[0].cells.goodreads_id, "[50](https://www.goodreads.com/book/show/50)");
	assert.ok(text.includes("> [!note]- How to edit this table by hand") && text.endsWith("Text below the table.\n"));
	assert.match(result.messages.join("\n"), /1 new row\(s\) have no Labels yet/);
	assert.deepEqual(result.todos?.map((t) => [t.key, t.check]), [["labels:50", { kind: "rowLabels", goodreadsId: "50" }]]);
});

test("apply: unticked changes write nothing; nothing ticked means no write at all", async () => {
	const vault = setup();
	const ctx = context(vault, { goodreads: { fetchShelf: async () => FEED } });
	const plan = await planPull(ctx, { labelSuggestions: false });
	plan.changes.find((c) => c.id === "add:50")!.selected = false;
	await applyPull(ctx, selectedChanges(plan));
	assert.ok(!vault.files.get(BACKLOG)!.includes("Brand New"));
	const untouched = setup();
	await applyPull(context(untouched), []);
	assert.equal(untouched.writes.length, 0);
});

test("apply: a hand edit since the plan wins over fill-if-blank; a row added meanwhile isn't doubled", async () => {
	const vault = setup();
	const ctx = context(vault, { goodreads: { fetchShelf: async () => FEED } });
	const plan = await planPull(ctx, { labelSuggestions: false });
	vault.files.set(BACKLOG, backlogFile([EXISTING, row({ title: "Typed By Hand", date: "2025-01-01", gr: "20" }), HAND, row({ title: "Brand New", date: "2026-04-01", gr: "50" })]));
	const result = await applyPull(ctx, selectedChanges(plan));
	const table = parseTable(vault.files.get(BACKLOG)!, "Title")!;
	assert.equal(table.rows.filter((r) => r.cells.Title === "Brand New").length, 1);
	const filled = table.rows.find((r) => r.cells.goodreads_id.includes("[20]"))!.cells;
	assert.equal(filled.Title, "Typed By Hand");
	assert.equal(filled.Author, "Bea");
	assert.deepEqual(result.skipped, [{ id: "add:50", reason: "already in the table" }]);
});

test("regression: a malformed row is matched by the URL in its line, never re-added, and kept verbatim", async () => {
	const vault = setup([EXISTING, MALFORMED]);
	const ctx = context(vault, { goodreads: { fetchShelf: async () => [shelf("30", "Odd one", "2025-06-02")] } });
	const plan = await planPull(ctx, { labelSuggestions: false });
	assert.equal(plan.changes.length, 0);
	assert.ok(plan.notes.some((n) => n.includes("cell count")));
});

test("plan: a table out of order gets a sort change even with nothing else to do", async () => {
	const vault = setup([BLANKS, EXISTING]);
	const ctx = context(vault, { goodreads: { fetchShelf: async () => [] } });
	const plan = await planPull(ctx);
	assert.deepEqual(plan.changes.map((c) => c.id), ["sort"]);
	await applyPull(ctx, selectedChanges(plan));
	assert.deepEqual(parseTable(vault.files.get(BACKLOG)!, "Title")!.rows.map((r) => r.original), [EXISTING, BLANKS]);
});

test("labels: suggested from the vocabulary with the guidance, refined from feedback, filtered at apply", async () => {
	const vault = setup();
	vault.files.set(LISTS, "**How Sam means these labels:**\nSci-Fi is only space stuff.\n\n| Label | hardcover_list |\n| --- | --- |\n");
	const calls: unknown[] = [];
	const ctx = context(vault, {
		goodreads: { fetchShelf: async () => [FEED[0]] },
		openai: {
			proposeLabels: async (entries, vocabulary, guidance) => {
				calls.push({ entries, vocabulary: [...vocabulary.keys()].sort(), guidance });
				return { "50": ["Sci-Fi"] };
			},
			refineLabels: async (_entries, proposals, feedback) => {
				calls.push({ proposals, feedback });
				return { "50": ["Sci-Fi", "essays"] };
			},
		},
	});
	const plan = await planPull(ctx);
	assert.equal(plan.changes[0].input?.value, "Sci-Fi");
	assert.ok(plan.changes[0].input?.options?.includes("Sci-Fi"), "the vocabulary rides along for suggestions in the review window");
	assert.deepEqual(calls[0], { entries: [{ id: "50", title: "Brand New", author: "Nia" }], vocabulary: ["Sci-Fi", "classics", "essays"], guidance: "Sci-Fi is only space stuff." });

	plan.changes[0].input!.value = "Sci-Fi, classics";
	await refinePullLabels(ctx, plan, "add essays");
	assert.deepEqual(calls[1], { proposals: { "50": ["Sci-Fi", "classics"] }, feedback: "add essays" });
	assert.equal(plan.changes[0].input?.value, "Sci-Fi, essays");

	plan.changes[0].input!.value = "sci-fi, Made Up, essays";
	const result = await applyPull(ctx, selectedChanges(plan));
	assert.equal(parseTable(vault.files.get(BACKLOG)!, "Title")!.rows[0].cells.Labels, "Sci-Fi, essays");
	assert.match(result.messages[0], /dropped labels not used in Database\/ yet: Made Up/);
});

test("labels: a failed suggestion leaves the field blank with a note; no key means no call", async () => {
	const failing = context(setup(), {
		goodreads: { fetchShelf: async () => [FEED[0]] },
		openai: { proposeLabels: async () => { throw new Error("HTTP 500"); } },
	});
	const plan = await planPull(failing);
	assert.equal(plan.changes[0].input?.value, "");
	assert.ok(plan.notes.some((n) => n.includes("Label suggestion failed (HTTP 500)")));
	const noKey = await planPull(context(setup(), { goodreads: { fetchShelf: async () => [FEED[0]] }, settings: { openaiKey: "" } }));
	assert.ok(noKey.notes.some((n) => n.includes("No OpenAI API key")));
});

test("vocabularyLabels: vocabulary spelling, duplicates dropped, empty vocabulary keeps everything", () => {
	assert.deepEqual(vocabularyLabels("sci-fi, Sci-Fi, nope", ["Sci-Fi"]), { kept: ["Sci-Fi"], dropped: ["nope"] });
	assert.deepEqual(vocabularyLabels("anything", []), { kept: ["anything"], dropped: [] });
	assert.equal(SETTINGS.booksFolder, "Books");
});

test("regression: two rows with the same goodreads_id are both kept (the Python's dict dropped one), only the first updated", async () => {
	const twin = row({ title: "Twin", author: "Twi", date: "2026-01-01", gr: "10", notes: "typo id" });
	const vault = setup([EXISTING, twin]);
	const ctx = context(vault, { goodreads: { fetchShelf: async () => [FEED[1]] } });
	const plan = await planPull(ctx, { labelSuggestions: false });
	assert.ok(plan.notes.some((n) => n.includes("Two rows have goodreads_id 10")));
	await applyPull(ctx, selectedChanges(plan));
	const rows = parseTable(vault.files.get(BACKLOG)!, "Title")!.rows;
	assert.deepEqual(rows.map((r) => [r.cells.Title, r.cells.DateAdded]), [["Known", "2026-03-05"], ["Twin", "2026-01-01"]]);
});
