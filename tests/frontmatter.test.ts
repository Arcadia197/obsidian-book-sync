import { test } from "node:test";
import { strict as assert } from "node:assert";
import { frontmatterRange, getField, getList, LABELS_STYLE, OWNED_STYLE, setField, setList, unquote } from "../src/core/frontmatter";

const NOTE = [
	"---",
	"author: Ann Author",
	'title: "Book: A Story"',
	"dateRead:",
	"labels:",
	"  - Sci-Fi",
	"  - french",
	"language_read: French",
	"owned: Julius",
	"rereads: []",
	"---",
	"# Book",
	"labels: this line is in the body, not frontmatter",
	"",
].join("\n");

test("frontmatterRange: between the --- lines; none without an opening line", () => {
	const range = frontmatterRange(NOTE)!;
	assert.ok(NOTE.slice(range.start, range.end).startsWith("author:"));
	assert.ok(NOTE.slice(range.end).startsWith("---\n# Book"));
	assert.equal(frontmatterRange("# no frontmatter\n"), null);
	assert.equal(frontmatterRange("---\nunclosed: yes\n"), null);
});

test("getField: raw value, blank as '', missing as null, body lines ignored", () => {
	assert.equal(getField(NOTE, "title"), '"Book: A Story"');
	assert.equal(unquote(getField(NOTE, "title")!), "Book: A Story");
	assert.equal(getField(NOTE, "dateRead"), "");
	assert.equal(getField(NOTE, "medium"), null);
	assert.equal(getField(NOTE, "rereads"), "[]");
});

test("setField: changes only that line", () => {
	const out = setField(NOTE, "dateRead", "2026-09-28");
	assert.equal(out, NOTE.replace("dateRead:\n", "dateRead: 2026-09-28\n"));
});

test("setField: a missing key is added at the end of the frontmatter, not silently skipped", () => {
	const out = setField(NOTE, "rating_10", 7);
	assert.ok(out.includes("rereads: []\nrating_10: 7\n---\n"));
});

test("setField: key prefixes don't collide (rating vs rating_10)", () => {
	const note = "---\nrating_10: 4\n---\n";
	assert.equal(getField(note, "rating"), null);
	assert.equal(setField(note, "rating", 1), "---\nrating_10: 4\nrating: 1\n---\n");
});

test("getList: block items, flow list, scalar, blank, missing", () => {
	assert.deepEqual(getList(NOTE, "labels"), ["Sci-Fi", "french"]);
	assert.deepEqual(getList(NOTE, "owned"), ["Julius"]);
	assert.deepEqual(getList(NOTE, "rereads"), []);
	assert.deepEqual(getList(NOTE, "dateRead"), []);
	assert.equal(getList(NOTE, "genre"), null);
	assert.deepEqual(getList("---\nlabels: [a, b]\n---\n", "labels"), ["a", "b"]);
});

test("setList: labels style, the body's labels line is never touched", () => {
	const out = setList(NOTE, "labels", ["Sci-Fi", "french", "classics"], LABELS_STYLE);
	assert.equal(out, NOTE.replace("  - french\n", "  - french\n  - classics\n"));
	assert.equal(setList(NOTE, "labels", [], LABELS_STYLE), NOTE.replace("labels:\n  - Sci-Fi\n  - french\n", "labels: []\n"));
});

test("setList: owned style is a scalar for one name, a list for several, blank for none", () => {
	const two = setList(NOTE, "owned", ["Julius", "Klara"], OWNED_STYLE);
	assert.ok(two.includes("owned:\n  - Julius\n  - Klara\nrereads"));
	assert.deepEqual(getList(two, "owned"), ["Julius", "Klara"]);
	assert.equal(setList(two, "owned", ["Julius"], OWNED_STYLE), NOTE);
	assert.ok(setList(NOTE, "owned", [], OWNED_STYLE).includes("owned:\nrereads"));
});

test("round trip: re-rendering an unchanged list gives the same text", () => {
	assert.equal(setList(NOTE, "labels", getList(NOTE, "labels")!, LABELS_STYLE), NOTE);
	assert.equal(setList(NOTE, "owned", getList(NOTE, "owned")!, OWNED_STYLE), NOTE);
});

test("setField on a note without frontmatter throws", () => {
	assert.throws(() => setField("# just a body\n", "dateRead", "x"), /no frontmatter/);
});
