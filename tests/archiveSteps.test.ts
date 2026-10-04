import { test } from "node:test";
import { strict as assert } from "node:assert";
import { applyReconcile, planReconcile } from "../src/steps/reconcile";
import { applyPromote, planPromote } from "../src/steps/promote";
import { selectedChanges } from "../src/core/changes";
import { getField, getList } from "../src/core/frontmatter";
import { parseTable } from "../src/core/table";
import type { HardcoverUserBook } from "../src/core/hardcoverTypes";
import { shelfUrl } from "../src/api/goodreads";
import { MemoryVault } from "./memoryVault";
import { BACKLOG, backlogFile, context, DB, noteText, notePath, row, SETTINGS } from "./stepFixtures";

function userBook(id: number, title: string, author: string, status: number, edition = true): HardcoverUserBook {
	const credits = [{ contribution: null, author: { name: author } }];
	return {
		book_id: id,
		status_id: status,
		rating: status === 3 ? 4.5 : null,
		owned: true,
		first_started_reading_date: "2026-09-01",
		first_read_date: status === 3 ? "2026-09-20" : null,
		edition: edition ? { title, isbn_13: `978${id}`, pages: 200, image: { url: `https://img.example/${id}.jpg` }, language: { language: "English" }, contributions: credits } : null,
		book: { title, slug: `book-${id}`, description: "A made-up book.", release_date: "2001-01-01", literary_type_id: 1, contributions: credits },
	};
}

// --- reconcile

test("reconcile: rows whose book has a note are offered for removal, with their Notes; apply removes only ticked ones", async () => {
	const rows = [
		row({ title: "Started", author: "Sta", date: "2026-03-01", gr: "1", notes: "owned by Lea" }),
		row({ title: "Waiting", author: "Wai", date: "2026-02-01", gr: "2" }),
		row({ title: "Also Started", author: "Als", date: "2026-01-01", gr: "3" }),
	];
	const vault = new MemoryVault({
		[BACKLOG]: backlogFile(rows),
		[notePath("Started", "Sta")]: noteText({ title: "Started", author: "Sta", hc: 1, gr: "1" }),
		[notePath("Also Started", "Als")]: noteText({ title: "Also Started", author: "Als", hc: 3, gr: "3" }),
	});
	const ctx = context(vault);
	const plan = await planReconcile(ctx);
	assert.deepEqual(plan.changes.map((c) => c.id), ["remove:1", "remove:3"]);
	assert.match(plan.changes[0].warnings[0], /owned by Lea/);
	plan.changes[1].selected = false;
	const result = await applyReconcile(ctx, selectedChanges(plan));
	assert.deepEqual(parseTable(vault.files.get(BACKLOG)!, "Title")!.rows.map((r) => r.original), [rows[1], rows[2]]);
	assert.deepEqual(result.applied, ["remove:1"]);
	assert.match(result.messages[0], /Goodreads by hand/);
	assert.deepEqual(result.todos?.map((t) => [t.key, t.text]), [["shelf:1", "Started (Sta): update its status on Goodreads (it's still on your to-read shelf)"]]);
	assert.deepEqual((await applyReconcile(ctx, selectedChanges(plan))).skipped.map((s) => s.id), ["remove:1"], "a second apply finds nothing to remove");
});

// --- promote

const ROW_PROMOTED = row({ title: "Reading Now", author: "Rea", date: "2026-03-01", genre: "Essay", labels: "Sci-Fi, owned", notes: "gift from Lea", gr: "11", hc: [101, "book-101"] });
const ROW_WAITING = row({ title: "Waiting", author: "Wai", date: "2026-02-01", gr: "12", hc: [102, "book-102"] });
const ROW_ARCHIVED = row({ title: "Has Note", author: "Han", date: "2026-01-01", gr: "13", hc: [103, "book-103"] });
const ROW_UNLINKED = row({ title: "Unlinked", author: "Unl", date: "2025-12-01", gr: "14" });
const ROW_MERGED = row({ title: "Merged Row", author: "Mer", date: "2025-11-01", gr: "15", hc: [150, "old-150"] });

function promoteSetup() {
	const vault = new MemoryVault({
		[BACKLOG]: backlogFile([ROW_PROMOTED, ROW_WAITING, ROW_ARCHIVED, ROW_UNLINKED, ROW_MERGED]),
		[notePath("Has Note", "Han")]: noteText({ title: "Has Note", author: "Han", hc: 103, gr: "13" }),
		// A merged id: the note's id lost a merge on Hardcover, the user's shelf points at the winner
		[notePath("Old Id", "Old")]: noteText({ title: "Old Id", author: "Old", hc: 170, gr: "17", dateRead: "2025-01-01" }),
	});
	const asked: unknown[] = [];
	const ctx = context(vault, {
		hardcover: {
			readingStatuses: async () => [
				{ book_id: 101, status_id: 2 },
				{ book_id: 103, status_id: 2 },
				{ book_id: 171, status_id: 3 },
				{ book_id: 151, status_id: 2 },
				{ book_id: 180, status_id: 3 },
			],
			resolveMerges: async (ids) => {
				asked.push([...new Set(ids)].sort());
				return new Map([
					["170", { id: 171, slug: "winner-171" }],
					["150", { id: 151, slug: "winner-151" }],
				]);
			},
			userBookDetails: async (ids) => {
				asked.push([...ids]);
				return [userBook(101, "Reading Now", "Rea", 2, false), userBook(151, "Merged Row", "Mer", 2), userBook(180, "Never Listed", "Nev", 3)];
			},
		},
		goodreads: {
			fetchShelf: async (url) => {
				asked.push(url);
				return [{ goodreadsId: "18", title: "Never Listed (Book 1)", author: "Nev", dateAdded: "2026-01-01", isbn: "" }];
			},
		},
	});
	return { vault, ctx, asked };
}

test("promote plan: merges resolved first, promoted rows, already archived, uncovered books, can't-check rows", async () => {
	const { vault, ctx, asked } = promoteSetup();
	const plan = await planPromote(ctx);
	assert.deepEqual(asked[0], ["101", "102", "103", "150", "170"]);
	assert.deepEqual(asked[1], ["101", "151", "180"], "details only for candidates and uncovered books");
	assert.equal(asked[2], "https://feeds.example/review/list_rss/1?key=KEY&shelf=read");
	assert.deepEqual(plan.changes.map((c) => [c.id, c.selected]), [
		["merge:Books/Database/Old - Old Id.md", true],
		["archived:13", true],
		["promote:101", true],
		["promote:151", true],
		["new:180", false],
	]);
	const promoted = plan.changes[2];
	assert.match(promoted.warnings[0], /IMPORTANT: no edition picked.*https:\/\/hardcover\.app\/books\/book-101/);
	assert.match(promoted.warnings[1], /gift from Lea/);
	assert.match(promoted.details[0], /edition \(none picked on Hardcover\)/);
	const uncovered = plan.changes[4];
	assert.equal(uncovered.input?.value, "18");
	assert.match(uncovered.warnings.join("\n"), /title \+ author match on your Goodreads "read" shelf/);
	assert.ok(plan.notes.some((n) => n.includes("Unlinked (Unl)")));
	assert.equal(vault.writes.length, 0);
});

test("promote apply: notes created (labels carried over minus owned), rows removed in one write, merge fixed", async () => {
	const { vault, ctx } = promoteSetup();
	const plan = await planPromote(ctx);
	plan.changes.find((c) => c.id === "new:180")!.selected = true;
	plan.changes.find((c) => c.id === "promote:151")!.selected = false;
	const result = await applyPromote(ctx, selectedChanges(plan));
	assert.deepEqual(result.applied.sort(), ["archived:13", "merge:Books/Database/Old - Old Id.md", "new:180", "promote:101"]);

	const created = vault.files.get(notePath("Reading Now", "Rea"))!;
	assert.equal(getField(created, "goodreads_id"), "https://www.goodreads.com/book/show/11");
	assert.deepEqual(getList(created, "labels"), ["Sci-Fi"]);
	assert.deepEqual(getList(created, "genre"), ["Essay"]);
	assert.equal(getField(created, "owned"), "Sam");
	const uncovered = vault.files.get(notePath("Never Listed", "Nev"))!;
	assert.equal(getField(uncovered, "goodreads_id"), "https://www.goodreads.com/book/show/18");
	assert.equal(getField(uncovered, "dateRead"), "2026-09-20");
	assert.equal(getField(uncovered, "rating_10"), "9");

	const old = vault.files.get(notePath("Old Id", "Old"))!;
	assert.equal(getField(old, "hardcover_id"), "171");
	assert.equal(getField(old, "hardcover_link"), "https://hardcover.app/books/winner-171");
	assert.deepEqual(parseTable(vault.files.get(BACKLOG)!, "Title")!.rows.map((r) => r.original), [ROW_WAITING, ROW_UNLINKED, ROW_MERGED]);
	assert.equal(vault.writes.filter((w) => w === BACKLOG).length, 1);
	assert.ok(result.messages.some((m) => /Goodreads by hand/.test(m)));
	const keys = result.todos!.map((t) => t.key);
	assert.ok(keys.includes(`fields:${notePath("Reading Now", "Rea")}`), "the new note's blank fields go on the list");
	assert.ok(keys.includes("shelf:11") && keys.includes("shelf:13"), "removed rows remind to update Goodreads");
	assert.ok(!keys.includes("shelf:18"), "a book never in the backlog has no shelf reminder");
});

test("promote: an edited Goodreads id is used, an unreadable one leaves it blank; an existing file is never overwritten", async () => {
	const { vault, ctx } = promoteSetup();
	const plan = await planPromote(ctx);
	const uncovered = plan.changes.find((c) => c.id === "new:180")!;
	uncovered.input!.value = "not an id";
	vault.files.set(notePath("Reading Now", "Rea"), "made by hand meanwhile");
	const result = await applyPromote(ctx, [uncovered, plan.changes.find((c) => c.id === "promote:101")!]);
	assert.equal(getField(vault.files.get(notePath("Never Listed", "Nev"))!, "goodreads_id"), "");
	assert.equal(vault.files.get(notePath("Reading Now", "Rea")), "made by hand meanwhile");
	assert.deepEqual(result.skipped, [{ id: "promote:101", reason: "Rea - Reading Now.md already exists, not overwritten" }]);
	assert.ok(vault.files.get(BACKLOG)!.includes("Reading Now"), "its row stays when no note was created");
	assert.ok(result.messages.some((m) => m.includes('"not an id"')));
});

test("promote: an existing note file at plan time is reported, not offered; nothing to do says so", async () => {
	const { vault, ctx } = promoteSetup();
	vault.files.set(notePath("Reading Now", "Rea"), noteText({ title: "Reading Now", author: "Rea" }));
	const plan = await planPromote(ctx);
	assert.ok(!plan.changes.some((c) => c.id === "promote:101"));
	assert.ok(plan.notes.some((n) => n.includes("Rea - Reading Now.md already exists")));

	const empty = context(new MemoryVault({ [BACKLOG]: backlogFile([]) }), { hardcover: { readingStatuses: async () => [], userBookDetails: async () => [] } });
	assert.ok((await planPromote(empty)).notes.some((n) => n.includes("nothing to do")));
});

test("promote: a shelf that can't be read is a warning on the item, not a failed plan", async () => {
	const { ctx } = promoteSetup();
	ctx.goodreads.fetchShelf = async () => {
		throw new Error("HTTP 500");
	};
	const plan = await planPromote(ctx);
	const uncovered = plan.changes.find((c) => c.id === "new:180")!;
	assert.equal(uncovered.input?.value, "");
	assert.match(uncovered.warnings.join("\n"), /Couldn't read your Goodreads "read" shelf \(HTTP 500\)/);
});

test("shelfUrl: swaps the shelf parameter, or adds one", () => {
	assert.equal(shelfUrl(SETTINGS.goodreadsRssUrl, "currently-reading"), "https://feeds.example/review/list_rss/1?key=KEY&shelf=currently-reading");
	assert.equal(shelfUrl("https://feeds.example/list?shelf=to-read&key=K", "read"), "https://feeds.example/list?shelf=read&key=K");
	assert.equal(shelfUrl("https://feeds.example/list?key=K", "read"), "https://feeds.example/list?key=K&shelf=read");
	assert.equal(DB, "Books/Database");
});
