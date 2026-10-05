import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
	addTombstones,
	blankFields,
	doneTodos,
	mergeDevices,
	mergeTodos,
	noteFieldsTodo,
	offShelfTodo,
	parseTodos,
	parseTombstones,
	renameTodoPaths,
	Todo,
	TodoChecks,
} from "../src/core/todos";

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
	assert.deepEqual([...(await doneTodos(todos, local))].sort(), ["fields:a", "labels:1"], "a missing note keeps its item (renames are followed)");

	const remote: TodoChecks = {
		...local,
		editions: async () => ({ tracked: new Set([7, 8]), picked: new Set([7]) }),
		shelfIds: async () => new Set(["6"]),
	};
	assert.deepEqual([...(await doneTodos(todos, remote))].sort(), ["edition:7", "edition:9", "fields:a", "labels:1", "shelf:5"]);

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

test("rating_10 is Hardcover's: its own item says to rate it there, with the book link", () => {
	const todos = noteFieldsTodo("DB/A.md", "A", ["medium", "rating_10"], "a-book");
	assert.deepEqual(todos.map((t) => [t.key, t.text, t.url ?? null]), [
		["fields:DB/A.md", "A: fill medium", null],
		["rating:DB/A.md", "A: rate it on Hardcover, then put the rating (times 2) into rating_10", "https://hardcover.app/books/a-book"],
	]);
});

test("renameTodoPaths: a renamed note's items follow it, others stay the same objects", () => {
	const other = todo("edition:1");
	const moved = renameTodoPaths([todo("fields:DB/Old.md", "x", { file: "DB/Old.md", check: { kind: "noteFields", path: "DB/Old.md", fields: ["medium"] } }), other], "DB/Old.md", "DB/New.md");
	assert.deepEqual(moved[0], { key: "fields:DB/New.md", text: "x", file: "DB/New.md", check: { kind: "noteFields", path: "DB/New.md", fields: ["medium"] } });
	assert.equal(moved[1], other);
});

test("mergeDevices: items from both devices survive, a removal on either side sticks, a newer re-add beats an older removal", () => {
	const phone = { todos: [todo("a", "a", { stamp: 10 }), todo("b", "b", { stamp: 10 })], done: addTombstones([], ["c"], 30) };
	const desktop = { todos: [todo("a", "a newer", { stamp: 20 }), todo("c", "c", { stamp: 20 }), todo("d", "d", { stamp: 40 })], done: addTombstones([], ["b", "d"], 35) };
	const merged = mergeDevices(phone, desktop);
	assert.deepEqual(merged.todos.map((t) => [t.key, t.text]), [["a", "a newer"], ["d", "d"]], "b removed on desktop, c removed on the phone after it was added; d re-added after its removal");
	assert.deepEqual(merged.done.map((t) => t.key).sort(), ["b", "c", "d"]);
	assert.deepEqual(mergeDevices(merged, merged).todos, merged.todos, "merging again changes nothing");
	assert.deepEqual(parseTombstones([{ key: "x", at: 1 }, { key: 2 }, null]), [{ key: "x", at: 1 }]);
});
