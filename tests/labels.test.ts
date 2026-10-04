import { test } from "node:test";
import { strict as assert } from "node:assert";
import { applyLabels, planLabels } from "../src/steps/labels";
import { selectedChanges } from "../src/core/changes";
import { getList } from "../src/core/frontmatter";
import type { HardcoverList } from "../src/api/hardcover";
import { MemoryVault } from "./memoryVault";
import { backlogFile, BACKLOG, context, LISTS, noteText, notePath, row } from "./stepFixtures";

const listLink = (id: number, slug: string) => `[${id}](https://hardcover.app/lists/${slug})`;
const LISTS_FILE = [
	"# Hardcover Lists",
	"",
	"**2026-01-01: how Sam means these labels (given to the AI):**",
	"- Sci-Fi: science fiction",
	"",
	"| Label | hardcover_list |",
	"| --- | --- |",
	`| Sci-Fi | ${listLink(10, "sci-fi")} |`,
	`| owned | ${listLink(11, "owned")} |`,
	`|  | ${listLink(12, "wishlist")} |`,
	"",
	"Text below.",
	"",
].join("\n");

/** Hardcover with lists and members that change as the stub writes */
function fakeHardcover() {
	const lists: HardcoverList[] = [
		{ id: 10, name: "Sci-Fi", slug: "sci-fi" },
		{ id: 11, name: "owned", slug: "owned" },
		{ id: 12, name: "wishlist", slug: "wishlist" },
		// Created by an earlier, interrupted run and never recorded
		{ id: 13, name: "Essays", slug: "essays" },
	];
	const members = new Map<number, Set<string>>([
		[10, new Set(["2", "51", "8"])],
		[11, new Set(["7", "8"])],
		[13, new Set(["6"])],
	]);
	const writes: string[] = [];
	let nextId = 900;
	let failCreate = false;
	const reads = {
		myLists: async () => lists.map((l) => ({ ...l })),
		listBookIds: async (id: number) => new Set(members.get(id) ?? []),
	};
	return {
		writes,
		lists,
		failNextCreate: () => (failCreate = true),
		reader: { ...reads, resolveMerges: async () => new Map([["50", { id: 51, slug: "winner-51" }]]) },
		writer: {
			...reads,
			createList: async (name: string) => {
				const list = { id: nextId++, name, slug: name.toLowerCase() };
				lists.push(list);
				writes.push(`createList ${name}`);
				if (failCreate) {
					failCreate = false;
					// The list exists on Hardcover, but the answer never arrived
					throw new Error("Hardcover didn't answer in time");
				}
				return list;
			},
			addListBook: async (listId: number, bookId: number) => {
				writes.push(`addListBook ${listId} ${bookId}`);
				members.set(listId, new Set([...(members.get(listId) ?? []), String(bookId)]));
			},
		},
	};
}

const notes = {
	n1: notePath("One", "Ann"),
	n2: notePath("Two", "Ben"),
	n3: notePath("Three", "Cat"),
	n4: notePath("Four", "Dot"),
};

function setup(settings = {}) {
	const files = {
		[LISTS]: LISTS_FILE,
		[BACKLOG]: backlogFile([
			row({ title: "Row A", author: "Ann", labels: "Sci-Fi", gr: "1", hc: [1, "one"] }),
			row({ title: "Row B", author: "Ben", gr: "2", hc: [2, "two"] }),
			row({ title: "Row C", author: "Cat", labels: "owned, Poetry", gr: "3", hc: [3, "three"] }),
			row({ title: "Row D", author: "Dan", labels: "Sci-Fi", gr: "4" }),
			row({ title: "Row E", author: "Eve", labels: "Wishlist", gr: "5", hc: [5, "five"] }),
			row({ title: "Row F", author: "Fay", labels: "Essays", gr: "6", hc: [6, "six"] }),
			row({ title: "Row G", author: "Gus", labels: "Sci-Fi", gr: "9", hc: [50, "old"] }),
		]),
		[notes.n1]: noteText({ title: "One", author: "Ann", hc: 1, labels: ["Sci-Fi"] }),
		[notes.n2]: noteText({ title: "Two", author: "Ben", hc: 7, labels: ["owned", "classics"] }).replace("owned: Sam", "owned:"),
		[notes.n3]: noteText({ title: "Three", author: "Cat", hc: 9 }).replace("labels: []\n", ""),
		[notes.n4]: noteText({ title: "Four", author: "Dot", hc: 8 }),
	};
	const vault = new MemoryVault(files);
	const hc = fakeHardcover();
	const ctx = context(vault, { hardcover: hc.reader, writer: hc.writer, settings });
	return { vault, ctx, hc, files };
}

test("plan: pulls, pushes (one per list and book), owned field, strays, merges, new and leftover lists; writes nothing", async () => {
	const { vault, ctx, hc, files } = setup();
	const plan = await planLabels(ctx);
	assert.deepEqual(plan.changes.map((c) => `${c.id} ${c.selected ? "ticked" : "unticked"}`), [
		"mergeRow:9 ticked",
		"list:essays ticked",
		"list:poetry unticked",
		"list:classics unticked",
		"pull:row:2:sci-fi ticked",
		`pull:${notes.n4}:sci-fi ticked`,
		`pull:${notes.n2}:owned ticked`,
		`strip:${notes.n2} ticked`,
		"push:sci-fi:1 unticked",
		"push:owned:3 unticked",
		"push:poetry:3 unticked",
		"push:classics:7 unticked",
		"push:owned:1 unticked",
	]);
	const byId = new Map(plan.changes.map((c) => [c.id, c]));
	const sciFi = byId.get("push:sci-fi:1")!.payload;
	assert.deepEqual(sciFi.kind === "push" && sciFi.sources.map((s) => [s.name, s.from, s.target.kind]), [["Row A (Ann)", "row", "row"], ["Ann - One", "note", "note"]]);
	assert.equal(byId.get("push:sci-fi:1")!.summary, 'Add Row A (Ann) / Ann - One to the Hardcover list "Sci-Fi"');
	const ownedPull = byId.get(`pull:${notes.n2}:owned`)!.payload;
	assert.deepEqual(ownedPull.kind === "pull" && [ownedPull.field, ownedPull.value], ["owned", "Sam"]);
	assert.match(byId.get("list:essays")!.summary, /existing Hardcover list "Essays" \(13\)/);
	assert.deepEqual(byId.get("push:poetry:3")!.warnings, ["Needs its list item ticked too (the list isn't in Hardcover Lists.md yet)"]);
	const text = plan.notes.join("\n");
	assert.match(text, /2 mapped label\(s\)\. 1 backlog row\(s\) and 0 note\(s\) skipped \(no hardcover_id\), 1 note\(s\) skipped \(no labels field\)/);
	assert.match(text, /Row D \(Dan\) \(labels: Sci-Fi\)/);
	assert.match(text, /Cat - Three/);
	assert.match(text, /Wishlist: your list "wishlist" has a blank Label/);
	assert.match(text, /no Labels yet[\s\S]*Row B \(Ben\)/);
	assert.deepEqual(hc.writes, []);
	assert.deepEqual(vault.writes, []);
	assert.deepEqual(Object.fromEntries(vault.files), files);
});

test("apply with the default ticks: local files only, no Hardcover write; a push whose list isn't ticked is skipped", async () => {
	const { vault, ctx, hc } = setup();
	const plan = await planLabels(ctx);
	plan.changes.find((c) => c.id === "push:poetry:3")!.selected = true;
	const result = await applyLabels(ctx.apply, selectedChanges(plan));
	assert.deepEqual(hc.writes, []);
	assert.deepEqual(result.skipped, [{ id: "push:poetry:3", reason: 'no Hardcover list for "Poetry" in Hardcover Lists.md (tick its list item to create it)' }]);
	const backlog = vault.files.get(BACKLOG)!;
	assert.ok(backlog.includes("| Row B | Ben |  |  | Sci-Fi |"));
	assert.ok(backlog.includes("[51](https://hardcover.app/books/winner-51) |"));
	assert.ok(vault.files.get(LISTS)!.endsWith(`| Essays | ${listLink(13, "essays")} |\n\nText below.\n`));
	const two = vault.files.get(notes.n2)!;
	assert.deepEqual(getList(two, "labels"), ["classics"]);
	assert.ok(two.includes("\nowned: Sam\n"));
	assert.deepEqual(getList(vault.files.get(notes.n4)!, "labels"), ["Sci-Fi"]);
	assert.equal(vault.files.get(notes.n1), noteText({ title: "One", author: "Ann", hc: 1, labels: ["Sci-Fi"] }));
});

test("apply everything: lists created and recorded one by one, books pushed once; applying again writes nothing", async () => {
	const { vault, ctx, hc } = setup();
	const plan = await planLabels(ctx);
	plan.changes.forEach((c) => (c.selected = true));
	const result = await applyLabels(ctx.apply, selectedChanges(plan));
	assert.deepEqual(result.skipped, []);
	assert.deepEqual(hc.writes, [
		"createList Poetry",
		"createList classics",
		"addListBook 10 1",
		"addListBook 11 3",
		"addListBook 11 1",
		"addListBook 900 3",
		"addListBook 901 7",
	]);
	const mapping = vault.files.get(LISTS)!;
	assert.ok(mapping.includes(`| ${listLink(12, "wishlist")} |\n| Essays | ${listLink(13, "essays")} |\n| Poetry | ${listLink(900, "poetry")} |\n| classics | ${listLink(901, "classics")} |\n`), mapping);

	const files = new Map(vault.files);
	const again = await applyLabels(ctx.apply, selectedChanges(plan));
	assert.equal(hc.writes.length, 7);
	assert.deepEqual(again.applied, []);
	assert.deepEqual(new Map(vault.files), files);
	assert.ok(again.skipped.every((s) => /already|changed since the plan|no owned in labels/.test(s.reason)), JSON.stringify(again.skipped));
});

test("a list created by an interrupted apply is linked on the retry, never created twice; writes stop after the error", async () => {
	const { vault, ctx, hc } = setup();
	let plan = await planLabels(ctx);
	plan.changes.forEach((c) => (c.selected = ["list:poetry", "push:poetry:3", "push:sci-fi:1"].includes(c.id)));
	hc.failNextCreate();
	const first = await applyLabels(ctx.apply, selectedChanges(plan));
	assert.deepEqual(hc.writes, ["createList Poetry"]);
	assert.deepEqual(first.skipped.map((s) => s.reason), [
		"Hardcover didn't answer in time",
		"not tried after the error above (Hardcover didn't answer in time)",
		"not tried after the error above (Hardcover didn't answer in time)",
	]);
	assert.ok(!vault.files.get(LISTS)!.includes("Poetry"));

	plan = await planLabels(ctx);
	const poetry = plan.changes.find((c) => c.id === "list:poetry")!;
	assert.match(poetry.summary, /Link your existing Hardcover list "Poetry" \(900\)/);
	assert.ok(poetry.selected && !poetry.writesHardcover);
	plan.changes.forEach((c) => (c.selected = ["list:poetry", "push:poetry:3"].includes(c.id)));
	const retry = await applyLabels(ctx.apply, selectedChanges(plan));
	assert.deepEqual(retry.applied, ["list:poetry", "push:poetry:3"]);
	assert.deepEqual(hc.writes, ["createList Poetry", "addListBook 900 3"]);
	assert.equal(hc.lists.filter((l) => l.name === "Poetry").length, 1);
	assert.ok(vault.files.get(LISTS)!.includes(`| Poetry | ${listLink(900, "poetry")} |`));
});

test("no owner name: the notes' owned field is left out, with a note", async () => {
	const { ctx } = setup({ ownerName: "" });
	const plan = await planLabels(ctx);
	assert.ok(!plan.changes.some((c) => c.id.endsWith(":owned") || c.id === "push:owned:1"));
	assert.ok(plan.changes.some((c) => c.id === "push:owned:3"), "the backlog's owned label still syncs");
	assert.match(plan.notes.join("\n"), /No owner name set/);
});

test("regression: rows found only by their line get every change (merge fix + two pulls); shared Goodreads ids get unique change ids", async () => {
	const vault = new MemoryVault({
		[LISTS]: LISTS_FILE,
		[BACKLOG]: backlogFile([
			row({ title: "No Goodreads", author: "Nog", hc: [50, "old"] }),
			row({ title: "Twin One", author: "Tw", gr: "3", hc: [3, "three"] }),
			row({ title: "Twin Two", author: "Tw", gr: "3", hc: [33, "thirty-three"] }),
		]),
	});
	const members = new Map([[10, new Set(["51", "3", "33"])], [11, new Set(["51"])]]);
	const ctx = context(vault, {
		hardcover: {
			resolveMerges: async () => new Map([["50", { id: 51, slug: "winner-51" }]]),
			listBookIds: async (id) => members.get(id) ?? new Set(),
		},
	});
	const plan = await planLabels(ctx);
	assert.deepEqual(plan.changes.map((c) => c.id), ["mergeRow:#0", "pull:row:#0:sci-fi", "pull:row:#0:owned", "pull:row:#1:sci-fi", "pull:row:#2:sci-fi"]);
	const result = await applyLabels(ctx.apply, selectedChanges(plan));
	assert.deepEqual(result.skipped, []);
	const lines = vault.files.get(BACKLOG)!.split("\n");
	assert.ok(lines.some((l) => l.startsWith("| No Goodreads | Nog |  |  | Sci-Fi, owned |") && l.endsWith("| [51](https://hardcover.app/books/winner-51) |")), lines.join("\n"));
	assert.ok(lines.some((l) => l.startsWith("| Twin One | Tw |  |  | Sci-Fi |")));
	assert.ok(lines.some((l) => l.startsWith("| Twin Two | Tw |  |  | Sci-Fi |")));
});
