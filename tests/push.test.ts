import { test } from "node:test";
import { strict as assert } from "node:assert";
import { applyPush, planPush } from "../src/steps/push";
import { selectedChanges } from "../src/core/changes";
import { doneTodos } from "../src/core/todos";
import type { TrackedBook } from "../src/api/hardcover";
import { MemoryVault } from "./memoryVault";
import { backlogFile, BACKLOG, context, row } from "./stepFixtures";

const tracked = (book_id: number, status_id: number, title: string, author: string): TrackedBook => ({
	book_id,
	status_id,
	book: { title, contributions: [{ contribution: null, author: { name: author } }] },
});

function setup() {
	const file = backlogFile([
		row({ title: "New One", author: "Ann", date: "2026-10-01", gr: "1", hc: [101, "new-one"] }),
		row({ title: "Reading Already", author: "Bob", gr: "2", hc: [102, "reading-already"] }),
		row({ title: "Die Kopie", author: "Cee Dee", gr: "3", hc: [103, "die-kopie"] }),
		row({ title: "Unlinked", author: "Dan", gr: "4" }),
		row({ title: "Stale", author: "Eve", gr: "5", hc: [50, "old-slug"] }),
		row({ title: "Stale Tracked", author: "Fay", gr: "6", hc: [60, "old-60"] }),
		"| Broken | Gus | 2026-01-01 |  |  | a | stray |  | [7](https://www.goodreads.com/book/show/7) | [107](https://hardcover.app/books/broken) |",
		row({ title: "No Date", author: "Hal", gr: "8", hc: [108, "no-date"] }),
		row({ title: "Shelved Under Old Id", author: "Ivy", gr: "9", hc: [70, "old-70"] }),
	]);
	const vault = new MemoryVault({ [BACKLOG]: file });
	let onHardcover: number[] = [];
	const ctx = context(vault, {
		hardcover: {
			trackedBooks: async () => [
				tracked(102, 2, "Reading Already", "Bob"),
				// Same real book as row 3 under another book id
				tracked(203, 1, "Die Kopie (German Edition)", "Cee Dee"),
				tracked(61, 3, "Stale Tracked", "Fay"),
				// Still on the shelf under the id Hardcover merged away
				tracked(70, 1, "Altered Title", "Ivy"),
			],
			resolveMerges: async () => new Map([["50", { id: 51, slug: "new-slug" }], ["60", { id: 61, slug: "winner-61" }], ["70", { id: 71, slug: "winner-71" }]]),
		},
		writer: {
			finishedInfo: async () => onHardcover.map((book_id) => ({ book_id, status_id: 1, rating: null, review: null, first_read_date: null })),
		},
	});
	return { vault, ctx, file, setOnHardcover: (ids: number[]) => (onHardcover = ids) };
}

test("plan: only books with no status on Hardcover, merged ids checked as the winner, duplicates and the rest reported, all unticked", async () => {
	const { vault, ctx, file } = setup();
	const plan = await planPush(ctx);
	assert.deepEqual(plan.changes.map((c) => c.id), ["push:101", "push:51", "push:108"]);
	assert.ok(plan.changes.every((c) => c.writesHardcover && !c.selected && c.ready));
	assert.deepEqual(plan.changes[0].payload, { bookId: 101, storedId: 101, dateAdded: "2026-10-01", slug: "new-one", name: "New One (Ann)" });
	assert.equal(plan.changes[1].payload.slug, "new-slug");
	const notes = plan.notes.join("\n");
	assert.match(notes, /3 row\(s\) to add.*3 already on your Hardcover shelves.*1 without a hardcover_id.*1 possible duplicate/);
	assert.match(notes, /Die Kopie \(Cee Dee\): row's hardcover_id 103, already tracked as 203 \(Want to Read\)/);
	assert.match(notes, /Stale \(Eve\): 50 -> 51 \(new-slug\)/);
	assert.match(notes, /stray[\s\S]*\| Broken \|/);
	assert.equal(vault.files.get(BACKLOG), file);
});

test("apply: nothing ticked sends nothing; ticked rows are added with their date, an edition link follows", async () => {
	const { ctx } = setup();
	const plan = await planPush(ctx);
	assert.deepEqual(await applyPush(ctx.apply, selectedChanges(plan)), { applied: [], skipped: [], messages: [] });
	assert.deepEqual(ctx.writes, []);

	plan.changes.forEach((c) => (c.selected = c.id !== "push:51"));
	const result = await applyPush(ctx.apply, selectedChanges(plan));
	assert.deepEqual(ctx.writes, ["addWantToRead 101 2026-10-01", "addWantToRead 108 -"]);
	assert.deepEqual(result.applied, ["push:101", "push:108"]);
	assert.match(result.messages[0], /no edition picked/);
	assert.deepEqual(result.messages.slice(1), ["  - New One (Ann): https://hardcover.app/books/new-one", "  - No Date (Hal): https://hardcover.app/books/no-date"]);
	assert.deepEqual(result.todos?.map((t) => [t.key, t.text, t.url, t.check]), [
		["edition:101", "New One (Ann): pick your edition on Hardcover (if Hardcover's default is yours, tick this off)", "https://hardcover.app/books/new-one", { kind: "edition", bookId: 101, notPicked: [1010, 1011] }],
		["edition:108", "No Date (Hal): pick your edition on Hardcover (if Hardcover's default is yours, tick this off)", "https://hardcover.app/books/no-date", { kind: "edition", bookId: 108, notPicked: [1080, 1081] }],
	], "each pushed book's edition goes on the Left for you list, with the editions Hardcover set by itself");
	assert.equal(ctx.vault.writes.length, 0);
});

test("apply: a book on Hardcover by now (second apply, earlier interrupted run) is not added again", async () => {
	const { ctx, setOnHardcover } = setup();
	const plan = await planPush(ctx);
	plan.changes.forEach((c) => (c.selected = true));
	// 101 added meanwhile; 51 is on the shelf under its old id 50
	setOnHardcover([101, 50]);
	const result = await applyPush(ctx.apply, selectedChanges(plan));
	assert.deepEqual(ctx.writes, ["addWantToRead 108 -"]);
	assert.deepEqual(result.skipped, [
		{ id: "push:101", reason: "already on your Hardcover shelves" },
		{ id: "push:51", reason: "already on your Hardcover shelves" },
	]);
});

test("apply: Hardcover's refusal is reported; a network error stops the remaining writes", async () => {
	const { ctx } = setup();
	const plan = await planPush(ctx);
	plan.changes.forEach((c) => (c.selected = true));
	ctx.apply.hardcover.finishedInfo = async () => [];
	ctx.apply.hardcover.addWantToRead = async (bookId) => {
		ctx.writes.push(`addWantToRead ${bookId}`);
		if (bookId === 101) return { id: null, error: "Book not found" };
		throw new Error("Hardcover didn't answer in time");
	};
	const result = await applyPush(ctx.apply, selectedChanges(plan));
	assert.deepEqual(ctx.writes, ["addWantToRead 101", "addWantToRead 51"]);
	assert.deepEqual(result.applied, []);
	assert.deepEqual(result.skipped.map((s) => s.reason), [
		"Hardcover refused: Book not found",
		"Hardcover didn't answer in time",
		"not tried after the error above (Hardcover didn't answer in time)",
	]);
	assert.deepEqual(result.messages, []);
	assert.deepEqual(result.todos?.map((t) => t.key), ["edition:51"], "a timed-out insert may have landed: its edition reminder is kept (the check drops it if not)");
});

test("regression: Hardcover's own default edition after a push doesn't clear the edition item, your pick does", async () => {
	const { ctx } = setup();
	const plan = await planPush(ctx);
	plan.changes.forEach((c) => (c.selected = c.id === "push:101"));
	// Read right after the insert, before Hardcover set its default (it takes a moment): the defaults still count
	ctx.apply.hardcover.shelfEditions = async () => new Map([[101, { edition: null, defaults: [17836879, 5382573] }]]);
	const [item] = (await applyPush(ctx.apply, selectedChanges(plan))).todos!;
	const onShelf = (edition: number | null) => ({ readNote: async () => null, rowLabels: async () => null, editions: async () => new Map([[101, edition]]) });
	assert.deepEqual([...(await doneTodos([item], onShelf(17836879)))], [], "Hardcover's default physical edition (the real case of 2026-10-05)");
	assert.deepEqual([...(await doneTodos([item], onShelf(null)))], [], "no edition yet");
	assert.deepEqual([...(await doneTodos([item], onShelf(42)))], ["edition:101"], "an edition you picked");

	// Couldn't read what Hardcover set: no baseline, so only a tick (or the book leaving the shelves) removes it
	ctx.apply.hardcover.finishedInfo = async () => [];
	ctx.apply.hardcover.shelfEditions = async () => {
		throw new Error("offline");
	};
	const [blind] = (await applyPush(ctx.apply, selectedChanges(plan))).todos!;
	assert.deepEqual(blind.check, { kind: "edition", bookId: 101 });
	assert.deepEqual([...(await doneTodos([blind], onShelf(42)))], []);
});
