import { test } from "node:test";
import { strict as assert } from "node:assert";
import { blankFields, doneTodos, mergeTodos, noteFieldsTodo, offShelfTodo, parseTodos, Todo, TodoChecks } from "../src/core/todos";

const todo = (key: string, text = key, extra: Partial<Todo> = {}): Todo => ({ key, text, ...extra });

test("mergeTodos: new items appended with today's date, a known key updated in place and keeps its first date", () => {
	const existing = [todo("a", "old text", { added: "2026-10-01" }), todo("b", "b", { added: "2026-10-02" })];
	const merged = mergeTodos(existing, [todo("a", "new text"), todo("c")], "2026-10-05");
	assert.deepEqual(merged.map((t) => [t.key, t.text, t.added]), [["a", "new text", "2026-10-01"], ["b", "b", "2026-10-02"], ["c", "c", "2026-10-05"]]);
	assert.equal(existing[0].text, "old text", "the input list is not changed");
});

test("parseTodos: keeps well-formed items from data.json, drops the rest", () => {
	const parsed = parseTodos([
		{ key: "fields:a.md", text: "A: fill medium", added: "2026-10-01", file: "a.md", check: { kind: "noteFields", path: "a.md", fields: ["medium"] } },
		{ key: "x", text: "bad check dropped, item kept", check: { kind: "edition", bookId: "12" } },
		{ key: "", text: "no key" },
		"junk",
		{ text: "no key at all" },
	]);
	assert.deepEqual(parsed.map((t) => [t.key, t.check?.kind ?? null]), [["fields:a.md", "noteFields"], ["x", null]]);
	assert.deepEqual(parseTodos(undefined), []);
});

test("noteFieldsTodo and offShelfTodo: the items promote, finished and reconcile hand over", () => {
	assert.deepEqual(noteFieldsTodo("DB/A.md", "A", ["medium", "edition (none picked on Hardcover)", "labels"]), [
		{ key: "fields:DB/A.md", text: "A: fill medium, labels", file: "DB/A.md", check: { kind: "noteFields", path: "DB/A.md", fields: ["medium", "labels"] } },
	]);
	assert.deepEqual(noteFieldsTodo("DB/A.md", "A", ["edition (none picked on Hardcover)"]), []);
	assert.equal(offShelfTodo("42", "Book (Ann)").url, "https://www.goodreads.com/book/show/42");
});

test("blankFields: missing keys, blank scalars and empty lists count as blank", () => {
	const text = "---\nmedium:\nowned: Sam\nlabels: []\nfiction: true\n---\n";
	assert.deepEqual(blankFields(text, ["medium", "owned", "labels", "fiction", "language_read"]), ["medium", "labels", "language_read"]);
});

test("doneTodos: local checks every time, remote ones when given; errors keep the item", async () => {
	const todos = [
		todo("fields:a", "a", { check: { kind: "noteFields", path: "a.md", fields: ["medium"] } }),
		todo("fields:b", "b", { check: { kind: "noteFields", path: "b.md", fields: ["medium"] } }),
		todo("fields:gone", "gone", { check: { kind: "noteFields", path: "gone.md", fields: ["medium"] } }),
		todo("labels:1", "l1", { check: { kind: "rowLabels", goodreadsId: "1" } }),
		todo("labels:2", "l2", { check: { kind: "rowLabels", goodreadsId: "2" } }),
		todo("edition:7", "e7", { check: { kind: "edition", bookId: 7 } }),
		todo("edition:8", "e8", { check: { kind: "edition", bookId: 8 } }),
		todo("edition:9", "e9", { check: { kind: "edition", bookId: 9 } }),
		todo("shelf:5", "s5", { check: { kind: "offShelf", goodreadsId: "5" } }),
		todo("shelf:6", "s6", { check: { kind: "offShelf", goodreadsId: "6" } }),
		todo("plain", "no check"),
	];
	const notes: Record<string, string> = { "a.md": "---\nmedium: paper\n---\n", "b.md": "---\nmedium:\n---\n" };
	const local: TodoChecks = {
		readNote: async (path) => notes[path] ?? null,
		rowLabels: async (id) => (id === "1" ? "Sci-Fi" : id === "2" ? "" : null),
	};
	assert.deepEqual([...(await doneTodos(todos, local))].sort(), ["fields:a", "fields:gone", "labels:1"]);

	const remote: TodoChecks = {
		...local,
		editions: async () => ({ tracked: new Set([7, 8]), picked: new Set([7]) }),
		shelfIds: async () => new Set(["6"]),
	};
	assert.deepEqual([...(await doneTodos(todos, remote))].sort(), ["edition:7", "edition:9", "fields:a", "fields:gone", "labels:1", "shelf:5"]);

	const offline: TodoChecks = {
		readNote: async () => {
			throw new Error("offline");
		},
		rowLabels: async () => {
			throw new Error("no backlog");
		},
		editions: async () => {
			throw new Error("offline");
		},
		shelfIds: async () => {
			throw new Error("offline");
		},
	};
	assert.deepEqual([...(await doneTodos(todos, offline))], [], "nothing goes away because a check failed");
});

test("regression: a blank owned is a valid answer, never a to-do; a cut-off shelf feed proves nothing", async () => {
	assert.deepEqual(noteFieldsTodo("DB/A.md", "A", ["owned"]), []);
	assert.equal(noteFieldsTodo("DB/A.md", "A", ["medium", "owned"])[0].text, "A: fill medium");
	const shelf = [todo("shelf:5", "s5", { check: { kind: "offShelf", goodreadsId: "5" } })];
	const checks: TodoChecks = { readNote: async () => null, rowLabels: async () => null, shelfIds: async () => null };
	assert.deepEqual([...(await doneTodos(shelf, checks))], [], "a full page of the feed (null) keeps the reminder");
});
