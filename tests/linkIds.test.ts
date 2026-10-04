import { test } from "node:test";
import { strict as assert } from "node:assert";
import { applyLink, planLink, resolveLinkInput } from "../src/steps/linkIds";
import { selectedChanges } from "../src/core/changes";
import { parseTable } from "../src/core/table";
import type { IsbnMatch } from "../src/api/hardcover";
import { MemoryVault } from "./memoryVault";
import { BACKLOG, backlogFile, context, row } from "./stepFixtures";

const ROWS = [
	row({ title: "Unique", author: "Uma", date: "2026-05-01", isbn: "111", gr: "1" }),
	row({ title: "Shared", author: "Sha", date: "2026-04-01", isbn: "222", gr: "2" }),
	row({ title: "Unknown", author: "Una", date: "2026-03-01", isbn: "333", gr: "3" }),
	row({ title: "Linked", author: "Lin", date: "2026-02-01", isbn: "444", gr: "4", hc: [44, "linked"] }),
	row({ title: "No Isbn", author: "Noi", date: "2026-01-01", gr: "5" }),
	row({ title: "Hand Row", author: "Han", date: "2025-12-01", isbn: "666" }),
];

const MATCHES: Record<string, IsbnMatch> = {
	"111": { book: { id: 101, slug: "unique" }, count: 1 },
	"222": { book: null, count: 2 },
	"333": { book: null, count: 0 },
	"666": { book: { id: 606, slug: "hand-row" }, count: 1 },
};

function setup() {
	const vault = new MemoryVault({ [BACKLOG]: backlogFile(ROWS) });
	const looked: string[] = [];
	const ctx = context(vault, {
		hardcover: {
			lookupIsbn: async (isbn) => {
				looked.push(isbn);
				return MATCHES[isbn];
			},
			booksBySlug: async (slug) => (slug === "shared-original" ? [{ id: 202, title: "Shared" }] : slug === "dup" ? [{ id: 1, title: "a" }, { id: 2, title: "b" }] : []),
		},
	});
	return { vault, ctx, looked };
}

test("plan: unique isbn ticked, ambiguous and unknown wait for a paste, linked and isbn-less rows not looked up", async () => {
	const { vault, ctx, looked } = setup();
	const plan = await planLink(ctx);
	assert.deepEqual(looked, ["111", "222", "333", "666"]);
	assert.deepEqual(plan.changes.map((c) => [c.id, c.selected, c.ready]), [
		["link:1", true, true],
		["link:2", false, false],
		["link:3", false, false],
		["link:row5", true, true],
	]);
	assert.match(plan.changes[1].summary, /matches 2 different Hardcover books/);
	assert.match(plan.changes[2].summary, /no Hardcover edition with isbn 333/);
	assert.equal(plan.changes[1].input?.kind, "hardcoverLink");
	assert.match(plan.notes[0], /2 matched, 1 ambiguous, 1 no match; 1 skipped \(no isbn\)/);
	assert.equal(vault.writes.length, 0);
});

test("paste: a URL resolves to its one book and ticks the change; blank, unknown and duplicate slugs keep it waiting", async () => {
	const { ctx } = setup();
	const plan = await planLink(ctx);
	const shared = plan.changes[1];
	shared.input!.value = "https://hardcover.app/books/shared-original/editions/123";
	assert.match(await resolveLinkInput(ctx.hardcover, shared), /Found "Shared" \(hardcover_id 202\)/);
	assert.deepEqual([shared.ready, shared.selected, shared.payload.bookId, shared.payload.slug], [true, true, 202, "shared-original"]);

	shared.input!.value = "dup";
	assert.match(await resolveLinkInput(ctx.hardcover, shared), /Several Hardcover books/);
	assert.deepEqual([shared.ready, shared.selected, shared.payload.bookId], [false, false, null]);
	shared.input!.value = "nothing-here";
	assert.match(await resolveLinkInput(ctx.hardcover, shared), /No Hardcover book found/);
	shared.input!.value = "  ";
	assert.equal(await resolveLinkInput(ctx.hardcover, shared), "");
});

test("apply: writes only the hardcover_id cells of ticked, ready changes; everything else byte for byte", async () => {
	const { vault, ctx } = setup();
	const plan = await planLink(ctx);
	plan.changes[1].input!.value = "shared-original";
	await resolveLinkInput(ctx.hardcover, plan.changes[1]);
	plan.changes[3].selected = false;
	const result = await applyLink(ctx, selectedChanges(plan));
	assert.deepEqual(result.applied, ["link:1", "link:2"]);
	const table = parseTable(vault.files.get(BACKLOG)!, "Title")!;
	assert.equal(table.rows[0].cells.hardcover_id, "[101](https://hardcover.app/books/unique)");
	assert.equal(table.rows[1].cells.hardcover_id, "[202](https://hardcover.app/books/shared-original)");
	assert.deepEqual(table.rows.slice(2).map((r) => r.original), ROWS.slice(2));
});

test("apply: a hardcover_id filled by hand since the plan is kept; an unkeyed row edited since is skipped", async () => {
	const { vault, ctx } = setup();
	const plan = await planLink(ctx);
	vault.files.set(BACKLOG, backlogFile([
		row({ title: "Unique", author: "Uma", date: "2026-05-01", isbn: "111", gr: "1", hc: [999, "by-hand"] }),
		...ROWS.slice(1, 5),
		row({ title: "Hand Row", author: "Han", date: "2025-12-01", isbn: "666", notes: "edited" }),
	]));
	const result = await applyLink(ctx, selectedChanges(plan));
	assert.deepEqual(result.skipped, [
		{ id: "link:1", reason: "hardcover_id was filled in meanwhile" },
		{ id: "link:row5", reason: "row not found (changed since the plan)" },
	]);
	assert.ok(vault.files.get(BACKLOG)!.includes("[999](https://hardcover.app/books/by-hand)"));
});
