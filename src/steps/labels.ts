// labels/sync: two-way, additive-only sync between labels in the vault and Hardcover lists, mapped in Hardcover
// Lists.md. Port of sync_hardcover_labels.py.
// - Pull: a book on a mapped list gets the label in its backlog row (Labels) and/or its Database/ note (labels)
// - Push: a book carrying a mapped label goes onto the list
// - A label with no mapping gets a list: an existing list of that name is linked (an interrupted run may have created
//   it without recording it), otherwise a new one is created. Its mapping row is written right after each list
// - `owned`: a plain label in the backlog. In notes the dedicated `owned` field (names) counts instead: only the owner
//   name from the settings syncs with the list. A stray `owned` inside a note's labels is removed
// - Nothing is ever removed, on either side. Every stored id is resolved through Hardcover's merges first
// Local changes start ticked, Hardcover writes unticked. apply() writes local files first, then Hardcover; it reads
// the mapping and list members again right before writing, so a second apply or a retry adds nothing twice, and it
// stops writing to Hardcover after the first error.

import type { ApplyResult, Change, Plan, VaultWriter } from "../core/changes";
import { emptyResult } from "../core/changes";
import { isOwnedLabel, sameName, setLabels, setOwned } from "../core/databaseNote";
import { getList, unquote } from "../core/frontmatter";
import { extractId } from "../core/idLinks";
import { appendMapping, ListsMapping, parseListsMapping } from "../core/listsMapping";
import { joinList, serializeTable, setCell, splitList } from "../core/table";
import type { HardcoverList } from "../api/hardcover";
import {
	describeNote,
	describeRow,
	findRow,
	loadBacklog,
	loadNotes,
	parseBacklog,
	paths,
	PlanContext,
	rowGoodreadsId,
	rowHardcoverId,
	RowKey,
	rowKey,
	Step,
	WritingApplyContext,
} from "./context";
import { applyMerge, applyRowMerge, mergeChange, MergePayload, mergeRowChange, RowMergePayload } from "./merges";

export type LabelTarget = { kind: "row"; key: RowKey } | { kind: "note"; path: string };

export type LabelsPayload =
	/** Adds `value` to a row's Labels, a note's labels, or (field "owned") a note's owned names */
	| { kind: "pull"; target: LabelTarget; field: "labels" | "owned"; value: string; name: string }
	/** Removes a leftover `owned` from a note's labels */
	| { kind: "strip"; path: string }
	/** Links the list of that name if there is one by then, else creates it; then records the mapping row */
	| { kind: "list"; label: string; existing: HardcoverList | null }
	/** Puts a book on the list mapped to `labelKey` (looked up again at apply time) */
	| { kind: "push"; labelKey: string; label: string; bookId: number; sources: PushSource[] }
	| MergePayload
	| RowMergePayload;

/** An entry carrying the label; `owned`: a note's owned field holds the owner name */
export interface PushSource {
	name: string;
	from: "row" | "note" | "owned";
	target: LabelTarget;
}

type LabelsChange = Change<LabelsPayload>;

const OWNED = "owned";

interface Entry {
	target: LabelTarget;
	/** Unique per entry, for change ids */
	ref: string;
	name: string;
	/** Canonical Hardcover id, or null */
	bookId: string | null;
	/** Labels as read (unquoted), `owned` excluded for notes */
	labels: string[];
	/** Notes only: owner names */
	owned: string[];
}

interface ListInfo {
	label: string;
	/** Null for a list that the plan creates */
	listId: number | null;
	members: Set<string>;
}

async function readMapping(vault: { read(path: string): Promise<string | null> }, path: string): Promise<{ text: string; mapping: ListsMapping }> {
	const text = await vault.read(path);
	if (text === null) {
		throw new Error(`${path} not found. Check the Hardcover lists file in the plugin settings.`);
	}
	const mapping = parseListsMapping(text);
	if (!mapping) {
		throw new Error(`No table with a "Label" column in ${path}. Restore the header row, or check the settings.`);
	}
	return { text, mapping };
}

function noteFile(target: LabelTarget): string | undefined {
	return target.kind === "note" ? target.path : undefined;
}

/** List ids that Hardcover Lists.md records with a blank Label: "leave this list alone" */
function ignoredListIds(mapping: ListsMapping): Set<number> {
	const ids = new Set<number>();
	for (const row of mapping.table.rows) {
		const id = extractId(row.cells["hardcover_list"] ?? "");
		if (!(row.cells["Label"] ?? "").trim() && /^\d+$/.test(id)) {
			ids.add(Number(id));
		}
	}
	return ids;
}

export async function planLabels(ctx: PlanContext): Promise<Plan<LabelsPayload>> {
	const { mapping } = await readMapping(ctx.vault, paths(ctx.settings).lists);
	const table = await loadBacklog(ctx.vault, ctx.settings);
	const notes = await loadNotes(ctx.vault, ctx.settings);
	const plan: Plan<LabelsPayload> = { step: "labels/sync", changes: [], notes: [] };
	const owner = ctx.settings.ownerName.trim();

	// --- Who carries which labels
	const rows: Entry[] = [];
	const malformed: string[] = [];
	const blankLabels: string[] = [];
	// A row's part of the change ids: its Goodreads id when no other row has it, else its position
	const goodreadsCount = new Map<string, number>();
	for (const row of table.rows) {
		const id = rowGoodreadsId(row);
		if (id) goodreadsCount.set(id, (goodreadsCount.get(id) ?? 0) + 1);
	}
	const rowRef = (i: number) => {
		const id = rowGoodreadsId(table.rows[i]);
		return id && goodreadsCount.get(id) === 1 ? id : `#${i}`;
	};
	table.rows.forEach((row, i) => {
		if (row.malformed) {
			malformed.push(`  - ${row.original}`);
			return;
		}
		const labels = splitList(row.cells["Labels"] ?? "");
		if (!labels.length) {
			blankLabels.push(`  - ${describeRow(row)}`);
		}
		const key = rowKey(row);
		rows.push({ target: { kind: "row", key }, ref: `row:${rowRef(i)}`, name: describeRow(row), bookId: rowHardcoverId(row), labels, owned: [] });
	});
	const noteEntries: Entry[] = [];
	const noLabelsField: string[] = [];
	const noteNoId: string[] = [];
	const strays: string[] = [];
	for (const { note } of notes) {
		if (note.labels === null) {
			noLabelsField.push(`  - ${describeNote(note)}`);
			continue;
		}
		if (!note.hardcoverId) {
			noteNoId.push(`  - ${describeNote(note)}`);
			continue;
		}
		if (note.labels.some(isOwnedLabel)) {
			strays.push(note.path);
		}
		noteEntries.push({
			target: { kind: "note", path: note.path },
			ref: note.path,
			name: describeNote(note),
			bookId: note.hardcoverId,
			labels: note.labels.map(unquote).filter((label) => label && !isOwnedLabel(label)),
			owned: note.owned.map(unquote).filter(Boolean),
		});
	}

	// --- Merged ids: matched as the winner, on-file fix offered per entry
	const merges = await ctx.hardcover.resolveMerges([...rows, ...noteEntries].map((e) => e.bookId).filter((id): id is string => !!id));
	const mergeChanges: LabelsChange[] = [];
	table.rows.forEach((row, i) => {
		const merged = !row.malformed ? merges.get(rowHardcoverId(row) ?? "") : undefined;
		if (merged) {
			mergeChanges.push(mergeRowChange(row, merged, rowRef(i)));
		}
	});
	for (const { note } of notes) {
		const merged = note.labels !== null && note.hardcoverId ? merges.get(note.hardcoverId) : undefined;
		if (merged) {
			mergeChanges.push(mergeChange(note, merged));
		}
	}
	for (const entry of [...rows, ...noteEntries]) {
		const merged = entry.bookId ? merges.get(entry.bookId) : undefined;
		if (merged) {
			entry.bookId = String(merged.id);
		}
	}

	// --- Lists: the mapped ones, plus one per label with no mapping yet
	const lists = new Map<string, ListInfo>();
	for (const [key, mapped] of mapping.mapped) {
		lists.set(key, { label: mapped.label, listId: mapped.listId, members: new Set() });
	}
	const unreadable = new Set(mapping.unreadable.map((label) => label.toLowerCase()));
	const unmapped = new Map<string, string>();
	for (const label of [...rows, ...noteEntries].flatMap((e) => e.labels).sort()) {
		const key = label.toLowerCase();
		if (!lists.has(key) && !unreadable.has(key) && !unmapped.has(key)) {
			unmapped.set(key, label);
		}
	}
	const listChanges: LabelsChange[] = [];
	const leftAlone: string[] = [];
	if (unmapped.size) {
		const ignored = ignoredListIds(mapping);
		const mine = await ctx.hardcover.myLists();
		for (const [key, label] of unmapped) {
			const existing = mine.find((list) => list.name.trim().toLowerCase() === key) ?? null;
			if (existing && ignored.has(existing.id)) {
				leftAlone.push(`  - ${label}: your list "${existing.name}" has a blank Label in Hardcover Lists.md`);
				continue;
			}
			lists.set(key, { label, listId: existing?.id ?? null, members: new Set() });
			listChanges.push({
				id: `list:${key}`,
				summary: existing
					? `Link your existing Hardcover list "${existing.name}" (${existing.id}) to the label "${label}" in Hardcover Lists.md`
					: `Create a Hardcover list "${label}" (public) and add it to Hardcover Lists.md`,
				details: existing ? ["Not in Hardcover Lists.md yet, maybe left over from an interrupted run"] : [],
				warnings: [],
				// Linking writes only Hardcover Lists.md, so it starts ticked like other local changes
				writesHardcover: !existing,
				selected: !!existing,
				ready: true,
				payload: { kind: "list", label, existing },
			});
		}
	}
	for (const info of lists.values()) {
		if (info.listId !== null) {
			info.members = await ctx.hardcover.listBookIds(info.listId);
		}
	}

	// --- Pull and push per entry, rows first (as the Python). One push per list and book, naming every entry that
	// carries the label (a row and a note can be the same book)
	const pulls: LabelsChange[] = [];
	const pushes = new Map<string, LabelsChange>();
	const addPush = (key: string, bookId: string, source: PushSource) => {
		const info = lists.get(key)!;
		const id = `push:${key}:${bookId}`;
		const existing = pushes.get(id);
		if (existing) {
			if (existing.payload.kind === "push" && !existing.payload.sources.some((s) => s.name === source.name)) {
				existing.payload.sources.push(source);
				existing.summary = `Add ${existing.payload.sources.map((s) => s.name).join(" / ")} to the Hardcover list "${info.label}"`;
			}
			return;
		}
		const pending = info.listId === null || listChanges.some((c) => c.id === `list:${key}`);
		pushes.set(id, {
			id,
			summary: `Add ${source.name} to the Hardcover list "${info.label}"`,
			details: [],
			warnings: pending ? [`Needs the list change for "${info.label}" too: ticking this ticks both`] : [],
			requires: listChanges.some((c) => c.id === `list:${key}`) ? `list:${key}` : undefined,
			writesHardcover: true,
			selected: false,
			ready: true,
			payload: { kind: "push", labelKey: key, label: info.label, bookId: Number(bookId), sources: [source] },
		});
	};
	for (const entry of [...rows, ...noteEntries]) {
		if (!entry.bookId) {
			continue;
		}
		const isNote = entry.target.kind === "note";
		const have = new Set(entry.labels.map((label) => label.toLowerCase()));
		for (const [key, info] of lists) {
			if ((isNote && key === OWNED) || have.has(key) || !info.members.has(entry.bookId)) {
				continue;
			}
			have.add(key);
			pulls.push({
				id: `pull:${entry.ref}:${key}`,
				summary: `${entry.name}: add the label "${info.label}" (the book is on that Hardcover list)`,
				details: [],
				warnings: [],
				writesHardcover: false,
				selected: true,
				ready: true,
				file: noteFile(entry.target),
				payload: { kind: "pull", target: entry.target, field: "labels", value: info.label, name: entry.name },
			});
		}
		for (const label of entry.labels) {
			const key = label.toLowerCase();
			if ((isNote && key === OWNED) || !lists.has(key) || lists.get(key)!.members.has(entry.bookId)) {
				continue;
			}
			addPush(key, entry.bookId, { name: entry.name, from: isNote ? "note" : "row", target: entry.target });
		}
	}

	// --- `owned` in notes: only the owner name from the settings syncs
	const ownedList = lists.get(OWNED);
	if (ownedList && !owner && noteEntries.length) {
		plan.notes.push('No owner name set in the plugin settings: the notes\' "owned" field is not synced with the "owned" list.');
	} else if (ownedList) {
		for (const entry of noteEntries) {
			if (!entry.bookId) {
				continue;
			}
			let isOwner = entry.owned.some((name) => sameName(name, owner));
			if (!isOwner && ownedList.members.has(entry.bookId)) {
				isOwner = true;
				pulls.push({
					id: `pull:${entry.ref}:${OWNED}`,
					summary: `${entry.name}: add ${owner} to the owned field (the book is on your Hardcover "${ownedList.label}" list)`,
					details: entry.owned.length ? [`Already owned by: ${entry.owned.join(", ")}`] : [],
					warnings: [],
					writesHardcover: false,
					selected: true,
					ready: true,
					file: noteFile(entry.target),
					payload: { kind: "pull", target: entry.target, field: "owned", value: owner, name: entry.name },
				});
			}
			if (isOwner && !ownedList.members.has(entry.bookId)) {
				addPush(OWNED, entry.bookId, { name: entry.name, from: "owned", target: entry.target });
			}
		}
	}

	const stripChanges: LabelsChange[] = strays.map((path) => ({
		id: `strip:${path}`,
		summary: `${noteEntries.find((e) => e.ref === path)?.name ?? path}: remove the leftover "owned" from labels (the owned field covers it)`,
		details: [],
		warnings: [],
		writesHardcover: false,
		selected: true,
		ready: true,
		file: path,
		payload: { kind: "strip", path },
	}));

	plan.changes.push(...mergeChanges, ...listChanges, ...pulls, ...stripChanges, ...pushes.values());

	const rowsNoId = rows.filter((e) => !e.bookId && e.labels.length).map((e) => `  - ${e.name} (labels: ${e.labels.join(", ")})`);
	plan.notes.unshift(
		`${mapping.mapped.size} mapped label(s). ${rowsNoId.length} backlog row(s) and ${noteNoId.length} note(s) skipped (no hardcover_id), ` +
			`${noLabelsField.length} note(s) skipped (no labels field).`,
	);
	const section = (header: string, items: string[]) => {
		if (items.length) {
			plan.notes.push(header, ...items);
		}
	};
	section("Backlog rows with labels but no hardcover_id (skipped):", rowsNoId);
	section("Notes without a hardcover_id (skipped):", noteNoId);
	section("Notes without a labels field (skipped, not migrated):", noLabelsField);
	section(`Rows whose cell count doesn't match the header (a stray "|"?), skipped. Fix them by hand:`, malformed);
	section("Hardcover Lists.md rows with a label but no readable list id (no list created for them, fix the row):", mapping.unreadable.map((l) => `  - ${l}`));
	section("Labels left alone (their list is marked to be left alone):", leftAlone);
	if (blankLabels.length) {
		plan.attention = ["Backlog rows with no Labels yet (they sync nothing; worth a look before applying):", ...blankLabels];
	}
	if (!plan.changes.length) {
		plan.notes.push("Nothing to sync: no changes in either direction.");
	}
	return plan;
}

/** Edits a note through `fn`, which returns the new text or a reason to skip. Null when written */
async function editNote(vault: VaultWriter, path: string, fn: (text: string) => string | { skip: string }): Promise<string | null> {
	if ((await vault.read(path)) === null) {
		return "note not found";
	}
	let reason: string | null = null;
	await vault.process(path, (text) => {
		const next = fn(text);
		if (typeof next === "string") {
			return next;
		}
		reason = next.skip;
		return text;
	});
	return reason;
}

function hasName(values: string[], value: string): boolean {
	return values.some((v) => sameName(v, value));
}

async function applyNotePull(vault: VaultWriter, path: string, field: "labels" | "owned", value: string): Promise<string | null> {
	return editNote(vault, path, (text) => {
		const current = getList(text, field);
		if (field === "labels" && current === null) {
			return { skip: "the note has no labels field anymore" };
		}
		if (hasName(current ?? [], value)) {
			return { skip: "already there" };
		}
		return field === "labels" ? setLabels(text, [...current!, value]) : setOwned(text, [...(current ?? []), value]);
	});
}

export async function applyLabels(ctx: WritingApplyContext, changes: LabelsChange[]): Promise<ApplyResult> {
	const result = emptyResult();
	const done = (change: LabelsChange, reason: string | null) =>
		reason ? result.skipped.push({ id: change.id, reason }) : result.applied.push(change.id);
	const of = <K extends LabelsPayload["kind"]>(kind: K) =>
		changes.filter((c): c is Change<Extract<LabelsPayload, { kind: K }>> & LabelsChange => c.payload.kind === kind);

	// --- Local files first: they can't fail halfway on the network
	for (const change of of("merge")) {
		done(change, await applyMerge(ctx.vault, change.payload));
	}
	// Row merges and row pulls in one write, every row found before any is edited (an edited row can't be found by
	// its planned line anymore)
	const pulls = of("pull");
	const rowChanges = [...of("mergeRow"), ...pulls.filter((c) => c.payload.target.kind === "row")];
	if (rowChanges.length) {
		const path = paths(ctx.settings).backlog;
		await ctx.vault.process(path, (text) => {
			const table = parseBacklog(text, path);
			const found = rowChanges.map((change) => {
				const payload = change.payload;
				const key = payload.kind === "mergeRow" ? payload.key : payload.kind === "pull" && payload.target.kind === "row" ? payload.target.key : null;
				return key ? findRow(table, key) : null;
			});
			rowChanges.forEach((change, i) => {
				const payload = change.payload;
				const row = found[i];
				if (payload.kind === "mergeRow") {
					done(change, applyRowMerge(table, row, payload));
					return;
				}
				if (payload.kind !== "pull" || !row || row.malformed) {
					done(change, row ? "the row's cell count doesn't match the header" : "row not found (changed since the plan)");
					return;
				}
				const labels = splitList(row.cells["Labels"] ?? "");
				if (hasName(labels, payload.value)) {
					done(change, "already there");
					return;
				}
				setCell(table, row, "Labels", joinList([...labels, payload.value]));
				done(change, null);
			});
			return serializeTable(table);
		});
	}
	for (const change of pulls) {
		const { target, field, value } = change.payload;
		if (target.kind === "note") {
			done(change, await applyNotePull(ctx.vault, target.path, field, value));
		}
	}
	for (const change of of("strip")) {
		done(
			change,
			await editNote(ctx.vault, change.payload.path, (text) => {
				const labels = getList(text, "labels") ?? [];
				const kept = labels.filter((label) => !isOwnedLabel(label));
				return kept.length === labels.length ? { skip: "no owned in labels anymore" } : setLabels(text, kept);
			}),
		);
	}

	// --- Hardcover: lists, then list members. Stops after the first error: the rest is reported, not tried
	let failure: string | null = null;
	const listsPath = paths(ctx.settings).lists;
	const guard = async (change: LabelsChange, write: () => Promise<string | null>) => {
		if (failure) {
			done(change, `not tried after the error above (${failure})`);
			return;
		}
		try {
			done(change, await write());
		} catch (err) {
			failure = err instanceof Error ? err.message : String(err);
			done(change, failure);
		}
	};

	let mine: HardcoverList[] | null = null;
	for (const change of of("list")) {
		await guard(change, async () => {
			const { label } = change.payload;
			const { mapping } = await readMapping(ctx.vault, listsPath);
			if (mapping.mapped.has(label.toLowerCase())) {
				return "already in Hardcover Lists.md";
			}
			// Looked up by name right before creating: a list an interrupted run created is linked, not made twice
			mine ??= await ctx.hardcover.myLists();
			let list = mine.find((l) => l.name.trim().toLowerCase() === label.toLowerCase()) ?? null;
			if (list && ignoredListIds(mapping).has(list.id)) {
				return `your list "${list.name}" has a blank Label in Hardcover Lists.md (left alone)`;
			}
			if (!list && change.payload.existing) {
				return `your list "${change.payload.existing.name}" is gone from Hardcover; plan again to create a new one`;
			}
			if (!list) {
				list = await ctx.hardcover.createList(label);
				mine.push(list);
				result.messages.push(`Created the Hardcover list "${label}": https://hardcover.app/lists/${list.slug}`);
			} else {
				result.messages.push(`Linked your existing Hardcover list "${list.name}" to the label "${label}".`);
			}
			// Recorded right away, before anything else can fail
			await ctx.vault.process(listsPath, (text) => appendMapping(text, label, list!.id, list!.slug));
			return null;
		});
	}

	const pushes = of("push");
	const byList = new Map<string, typeof pushes>();
	for (const change of pushes) {
		byList.set(change.payload.labelKey, [...(byList.get(change.payload.labelKey) ?? []), change]);
	}
	for (const [key, group] of byList) {
		let members: Set<string> | null = null;
		let listId: number | null = null;
		for (const change of group) {
			await guard(change, async () => {
				if (listId === null) {
					listId = (await readMapping(ctx.vault, listsPath)).mapping.mapped.get(key)?.listId ?? null;
				}
				if (listId === null) {
					return `no Hardcover list for "${change.payload.label}" in Hardcover Lists.md (tick its list item to create it)`;
				}
				// Members asked again right before writing: nothing is added to a list twice
				members ??= await ctx.hardcover.listBookIds(listId);
				if (members.has(String(change.payload.bookId))) {
					return "already on the list";
				}
				await ctx.hardcover.addListBook(listId, change.payload.bookId);
				members.add(String(change.payload.bookId));
				return null;
			});
		}
	}
	return result;
}

export const labels: Step<LabelsPayload, WritingApplyContext> = {
	id: "labels/sync",
	plan: planLabels,
	apply: applyLabels,
};
