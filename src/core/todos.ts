// "Left for you": things a sync can't do itself (pick an edition on Hardcover, fill a note's medium, add Labels to a
// new row, update Goodreads). Steps hand them over in ApplyResult.todos; the plugin keeps them in data.json, so
// Obsidian Sync shows the same list on every device. One item per key: a newer one replaces the older text but keeps
// its date. An item goes away when ticked off, or when its check finds it done. Removed keys are remembered for a
// while (tombstones), so a tick on one device also removes the item on another instead of coming back with its list.

import { getList, unquote } from "./frontmatter";

export type TodoCheck =
	/** Done when none of these frontmatter fields is blank anymore. A missing note keeps the item (renames are followed) */
	| { kind: "noteFields"; path: string; fields: string[] }
	/** Done when the backlog row has Labels (or is gone) */
	| { kind: "rowLabels"; goodreadsId: string }
	/** Done when the book on your Hardcover shelves has an edition picked (or isn't on them anymore) */
	| { kind: "edition"; bookId: number }
	/** Done when the book is no longer on the Goodreads shelf of the RSS URL (to-read) */
	| { kind: "offShelf"; goodreadsId: string };

/**
 * "Still needs by hand" names that aren't field to-dos: no frontmatter field (edition), blank is a valid answer (owned:
 * nobody owns it), or Hardcover owns it (rating_10: its own item, rate on Hardcover first)
 */
const NOT_FIELD_TODOS = /^(edition\b|owned$|rating_10$)/;

/** The items for a note's still-needed fields: one for the fields to fill, one to rate the book on Hardcover */
export function noteFieldsTodo(path: string, name: string, stillNeeded: string[], bookSlug?: string): Todo[] {
	const fields = stillNeeded.filter((f) => !NOT_FIELD_TODOS.test(f));
	const todos: Todo[] = fields.length ? [{ key: `fields:${path}`, text: `${name}: fill ${fields.join(", ")}`, file: path, check: { kind: "noteFields", path, fields } }] : [];
	if (stillNeeded.includes("rating_10")) {
		// Hardcover wins for ratings: rate it there, then the note gets it (rating x 2) by hand
		todos.push({
			key: `rating:${path}`,
			text: `${name}: rate it on Hardcover, then put the rating (times 2) into rating_10`,
			file: path,
			url: bookSlug ? `https://hardcover.app/books/${bookSlug}` : undefined,
			check: { kind: "noteFields", path, fields: ["rating_10"] },
		});
	}
	return todos;
}

/** After a backlog row went away because the book was started: Goodreads may still have it on the to-read shelf */
export function offShelfTodo(goodreadsId: string, name: string): Todo {
	return {
		key: `shelf:${goodreadsId}`,
		text: `${name}: update its status on Goodreads (Book Sync took it off Want to Read)`,
		url: `https://www.goodreads.com/book/show/${goodreadsId}`,
		check: { kind: "offShelf", goodreadsId },
	};
}

export interface Todo {
	/** What makes two items the same, e.g. "edition:123" */
	key: string;
	text: string;
	/** YYYY-MM-DD; set when the item is first kept */
	added?: string;
	/** A web page to do it on */
	url?: string;
	/** A vault file to do it in */
	file?: string;
	/** Without one, only a tick removes the item */
	check?: TodoCheck;
	/** When it was last added or updated (ms), to weigh it against a tombstone from another device */
	stamp?: number;
}

/** A removed item's key and when it was removed (ms) */
export interface Tombstone {
	key: string;
	at: number;
}

/** Tombstones kept: enough for months of syncs, small in data.json */
const MAX_TOMBSTONES = 300;

/** Adds tombstones for `keys`, newest kept */
export function addTombstones(done: Tombstone[], keys: Iterable<string>, now: number): Tombstone[] {
	const fresh = [...keys].map((key) => ({ key, at: now }));
	const merged = new Map<string, number>();
	for (const t of [...done, ...fresh]) merged.set(t.key, Math.max(merged.get(t.key) ?? 0, t.at));
	return [...merged].map(([key, at]) => ({ key, at })).sort((a, b) => b.at - a.at).slice(0, MAX_TOMBSTONES);
}

/**
 * Two devices' lists as one: every item either has, the newer copy of a key winning, minus items removed (ticked off or
 * found done) after they were last added. Order: `mine` first, then items only `theirs` has
 */
export function mergeDevices(mine: { todos: Todo[]; done: Tombstone[] }, theirs: { todos: Todo[]; done: Tombstone[] }): { todos: Todo[]; done: Tombstone[] } {
	const done = addTombstones([...mine.done, ...theirs.done], [], 0);
	const removedAt = new Map(done.map((t) => [t.key, t.at]));
	const byKey = new Map<string, Todo>();
	for (const todo of [...mine.todos, ...theirs.todos]) {
		const known = byKey.get(todo.key);
		if (!known || (todo.stamp ?? 0) > (known.stamp ?? 0)) byKey.set(todo.key, known ? { ...todo, added: known.added ?? todo.added } : todo);
	}
	const todos = [...byKey.values()].filter((todo) => (todo.stamp ?? 0) > (removedAt.get(todo.key) ?? -1));
	return { todos, done };
}

export function parseTombstones(raw: unknown): Tombstone[] {
	return Array.isArray(raw)
		? raw.filter((t): t is Tombstone => !!t && typeof t === "object" && typeof t.key === "string" && typeof t.at === "number")
		: [];
}

/** After a note was renamed or moved: its items follow it */
export function renameTodoPaths(todos: Todo[], oldPath: string, newPath: string): Todo[] {
	return todos.map((todo) => {
		const check = todo.check;
		const pathCheck = check?.kind === "noteFields" && check.path === oldPath;
		if (todo.file !== oldPath && !pathCheck) return todo;
		const moved: Todo = { ...todo, key: todo.key.replace(`:${oldPath}`, `:${newPath}`) };
		if (todo.file === oldPath) moved.file = newPath;
		if (pathCheck) moved.check = { ...check, path: newPath };
		return moved;
	});
}

/** `existing` with `incoming` merged in by key: new items appended, known ones updated in place (date kept) */
export function mergeTodos(existing: Todo[], incoming: Todo[], today: string): Todo[] {
	const merged = existing.map((todo) => ({ ...todo }));
	for (const todo of incoming) {
		const known = merged.findIndex((t) => t.key === todo.key);
		if (known >= 0) {
			merged[known] = { ...todo, added: merged[known].added ?? today, stamp: todo.stamp ?? merged[known].stamp };
		} else {
			merged.push({ ...todo, added: todo.added ?? today });
		}
	}
	return merged;
}

/** Items from data.json; anything malformed is dropped */
export function parseTodos(raw: unknown): Todo[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const todos: Todo[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const { key, text, added, url, file, check } = item as Record<string, unknown>;
		if (typeof key !== "string" || typeof text !== "string" || !key || !text) continue;
		const todo: Todo = { key, text };
		if (typeof added === "string") todo.added = added;
		if (typeof url === "string") todo.url = url;
		if (typeof file === "string") todo.file = file;
		if (isCheck(check)) todo.check = check;
		const stamp = (item as Record<string, unknown>).stamp;
		if (typeof stamp === "number") todo.stamp = stamp;
		todos.push(todo);
	}
	return todos;
}

function isCheck(value: unknown): value is TodoCheck {
	if (!value || typeof value !== "object") return false;
	const check = value as Record<string, unknown>;
	switch (check.kind) {
		case "noteFields":
			return typeof check.path === "string" && Array.isArray(check.fields) && check.fields.every((f) => typeof f === "string");
		case "rowLabels":
		case "offShelf":
			return typeof check.goodreadsId === "string";
		case "edition":
			return typeof check.bookId === "number";
		default:
			return false;
	}
}

/** Frontmatter fields of `text` that are missing or blank, of `fields` */
export function blankFields(text: string, fields: string[]): string[] {
	return fields.filter((field) => {
		const values = getList(text, field);
		return values === null || values.every((value) => unquote(value) === "");
	});
}

export interface TodoChecks {
	readNote(path: string): Promise<string | null>;
	/** Labels cell of the backlog row with this goodreads_id; null when there is no such row */
	rowLabels(goodreadsId: string): Promise<string | null>;
	/** Of these Hardcover book ids, the ones on your shelves with an edition picked, and the ones on your shelves */
	editions?(bookIds: number[]): Promise<{ picked: Set<number>; tracked: Set<number> }>;
	/** Goodreads ids on the to-read shelf; null when the feed may be cut off (a full page), so absence proves nothing */
	shelfIds?(): Promise<Set<string> | null>;
}

/**
 * The keys of items whose check finds them done. A check that can't run (offline, no key) keeps its items: nothing
 * disappears because of an error.
 */
export async function doneTodos(todos: Todo[], checks: TodoChecks): Promise<Set<string>> {
	const done = new Set<string>();
	for (const todo of todos) {
		const check = todo.check;
		try {
			if (check?.kind === "noteFields") {
				const text = await checks.readNote(check.path);
				if (text !== null && !blankFields(text, check.fields).length) done.add(todo.key);
			} else if (check?.kind === "rowLabels") {
				const labels = await checks.rowLabels(check.goodreadsId);
				if (labels === null || labels.trim()) done.add(todo.key);
			}
		} catch {
			// kept
		}
	}
	const editionTodos = todos.filter((t) => t.check?.kind === "edition");
	if (editionTodos.length && checks.editions) {
		try {
			const ids = editionTodos.map((t) => (t.check as { bookId: number }).bookId);
			const { picked, tracked } = await checks.editions(ids);
			for (const todo of editionTodos) {
				const id = (todo.check as { bookId: number }).bookId;
				if (picked.has(id) || !tracked.has(id)) done.add(todo.key);
			}
		} catch {
			// kept
		}
	}
	const shelfTodos = todos.filter((t) => t.check?.kind === "offShelf");
	if (shelfTodos.length && checks.shelfIds) {
		try {
			const onShelf = await checks.shelfIds();
			for (const todo of onShelf ? shelfTodos : []) {
				if (!onShelf!.has((todo.check as { goodreadsId: string }).goodreadsId)) done.add(todo.key);
			}
		} catch {
			// kept
		}
	}
	return done;
}
