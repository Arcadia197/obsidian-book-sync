import { test } from "node:test";
import { strict as assert } from "node:assert";
import { applyFinishedStep, planFinished } from "../src/steps/finished";
import { selectedChanges } from "../src/core/changes";
import { getField } from "../src/core/frontmatter";
import type { FinishedInfo } from "../src/api/hardcover";
import { MemoryVault } from "./memoryVault";
import { context, noteText, notePath } from "./stepFixtures";

const info = (book_id: number, status_id: number, rest: Partial<FinishedInfo> = {}): FinishedInfo => ({
	book_id,
	status_id,
	rating: null,
	review: null,
	first_read_date: null,
	...rest,
});

function setup() {
	const notes = {
		done: notePath("Done", "Don"),
		bare: notePath("Bare", "Bar"),
		reading: notePath("Reading", "Rea"),
		gone: notePath("Gone", "Gon"),
		merged: notePath("Merged", "Mer"),
		old: notePath("Old", "Old"),
		noId: notePath("No Id", "Noi"),
	};
	const vault = new MemoryVault({
		[notes.done]: noteText({ title: "Done", author: "Don", hc: 1 }),
		[notes.bare]: noteText({ title: "Bare", author: "Bar", hc: 2 }).replace("owned: Sam", "owned:"),
		[notes.reading]: noteText({ title: "Reading", author: "Rea", hc: 3 }),
		[notes.gone]: noteText({ title: "Gone", author: "Gon", hc: 4 }),
		[notes.merged]: noteText({ title: "Merged", author: "Mer", hc: 50 }),
		[notes.old]: noteText({ title: "Old", author: "Old", hc: 6, dateRead: "2020-01-01" }),
		[notes.noId]: noteText({ title: "No Id", author: "Noi" }),
	});
	const asked: unknown[] = [];
	const ctx = context(vault, {
		hardcover: {
			resolveMerges: async (ids) => {
				asked.push([...ids]);
				return new Map([["50", { id: 51, slug: "winner-51" }]]);
			},
			finishedInfo: async (ids) => {
				asked.push([...ids]);
				return [
					info(1, 3, { rating: 4.5, review: "Loved it.", first_read_date: "2026-09-30" }),
					info(2, 3, { first_read_date: "2026-09-29" }),
					info(3, 2),
					info(51, 3, { rating: 3, first_read_date: "2026-08-01" }),
				];
			},
		},
	});
	return { vault, ctx, asked, notes };
}

test("plan: only blank-dateRead notes with an id, merged ids checked as the winner, everything else reported", async () => {
	const { vault, ctx, asked, notes } = setup();
	const plan = await planFinished(ctx);
	assert.deepEqual(asked[0], ["2", "1", "4", "50", "3"]);
	assert.deepEqual(asked[1], ["2", "1", "4", "51", "3"]);
	assert.deepEqual(plan.changes.map((c) => c.id), [`merge:${notes.merged}`, `finished:${notes.bare}`, `finished:${notes.done}`, `finished:${notes.merged}`]);
	const [, bare, done] = plan.changes;
	assert.match(done.summary, /dateRead -> 2026-09-30, rating_10 -> 9, plus the Hardcover review/);
	assert.deepEqual(done.warnings, []);
	assert.deepEqual(bare.warnings, ["Missing on Hardcover: rating, review"]);
	assert.deepEqual(bare.details, ["Still needs by hand on the note: owned, labels"]);
	const notesText = plan.notes.join("\n");
	assert.match(notesText, /Noi - No Id/);
	assert.match(notesText, /no matching book on your Hardcover shelves[\s\S]*Gon - Gone/);
	assert.match(notesText, /Rea - Reading \(Currently Reading\)/);
	assert.equal(vault.writes.length, 0);
});

test("apply: dateRead, rating_10 and review written; an unticked note and the rest of the file untouched", async () => {
	const { vault, ctx, notes } = setup();
	const plan = await planFinished(ctx);
	plan.changes.find((c) => c.id === `finished:${notes.bare}`)!.selected = false;
	const before = vault.files.get(notes.bare);
	const result = await applyFinishedStep(ctx, selectedChanges(plan));
	const done = vault.files.get(notes.done)!;
	assert.equal(getField(done, "dateRead"), "2026-09-30");
	assert.equal(getField(done, "rating_10"), "9");
	assert.ok(done.includes("find all books in [[../List of books]]\n\n## Hardcover review\nLoved it."));
	assert.equal(vault.files.get(notes.bare), before);
	const merged = vault.files.get(notes.merged)!;
	assert.equal(getField(merged, "hardcover_id"), "51");
	assert.equal(getField(merged, "dateRead"), "2026-08-01");
	assert.equal(result.applied.length, 3);
	assert.ok(result.messages.includes("Updated Don - Done.md. Still needs by hand: labels."));
	assert.ok(result.todos?.some((t) => t.key === `fields:${notes.done}` && t.text === "Don - Done: fill labels"));
});

test("apply twice: the review is added only once", async () => {
	const { vault, ctx, notes } = setup();
	const plan = await planFinished(ctx);
	await applyFinishedStep(ctx, selectedChanges(plan));
	await applyFinishedStep(ctx, selectedChanges(plan));
	assert.equal(vault.files.get(notes.done)!.split("## Hardcover review").length, 2);
	const again = await applyFinishedStep(ctx, selectedChanges(plan).filter((c) => c.payload.kind === "merge"));
	assert.deepEqual(again.skipped, [{ id: `merge:${notes.merged}`, reason: "hardcover_id changed since the plan" }]);
});

test("a Read book without a read date keeps dateRead blank and says so", async () => {
	const vault = new MemoryVault({ [notePath("X", "Y")]: noteText({ title: "X", author: "Y", hc: 9 }) });
	const ctx = context(vault, { hardcover: { finishedInfo: async () => [info(9, 3, { rating: 2 })] } });
	const plan = await planFinished(ctx);
	assert.match(plan.changes[0].warnings.join("\n"), /no read date/);
	await applyFinishedStep(ctx, selectedChanges(plan));
	const text = vault.files.get(notePath("X", "Y"))!;
	assert.equal(getField(text, "dateRead"), "");
	assert.equal(getField(text, "rating_10"), "4");
});
