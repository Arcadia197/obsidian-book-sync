// `npm run check:parity`: every step's plan() against the real Books folder (BOOKS_DIR) next to the Python scripts'
// --dry-run output, compared item by item. Local only, not in CI. Reads only:
// - The plugin side gets a read-only file reader and the read-only Hardcover client. The pull step's apply runs on
//   an in-memory copy of the backlog, to compare the resulting table with the one the Python prints
// - The Python side runs only with --dry-run (pull also with --no-label-suggestions: no OpenAI calls).
//   reconcile_promoted.py has no --dry-run, so its read-only find_promoted() is imported instead
// Keys come from the scripts' own .env and are never printed.
// ONLY=push,labels runs just those sections (names: pull, link, push, labels, reconcile, promote, finished): every
// section makes live, paced API calls, so the full run takes minutes.
import { spawnSync } from "child_process";
import { readdirSync, readFileSync } from "fs";
import * as path from "path";
import { parse as parseEnv } from "dotenv";
import type { VaultReader } from "../../src/core/changes";
import { selectedChanges } from "../../src/core/changes";
import { parseTable, Table } from "../../src/core/table";
import { chooseAuthor, chooseTitle } from "../../src/core/noteBuilder";
import { unquote } from "../../src/core/frontmatter";
import { createHardcover } from "../../src/api/hardcover";
import { GoodreadsClient } from "../../src/api/goodreads";
import { OpenAiClient } from "../../src/api/openai";
import type { HttpFn } from "../../src/api/http";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { findRow, loadBacklog, loadNotes, PlanContext, rowHardcoverId } from "../../src/steps/context";
import { applyPull, planPull } from "../../src/steps/pullGoodreads";
import { planLink } from "../../src/steps/linkIds";
import { planReconcile } from "../../src/steps/reconcile";
import { planPromote } from "../../src/steps/promote";
import { planFinished } from "../../src/steps/finished";
import { planPush } from "../../src/steps/push";
import { planLabels } from "../../src/steps/labels";
import { MemoryVault } from "../memoryVault";

const booksDir = process.env.BOOKS_DIR!;
const scriptsDir = path.join(booksDir, "scripts");
const keys = parseEnv(readFileSync(path.join(scriptsDir, ".env")));

const fsVault: VaultReader = {
	async read(file) {
		try {
			return readFileSync(path.join(booksDir, file), "utf8");
		} catch {
			return null;
		}
	},
	async listNotes(folder) {
		try {
			return readdirSync(path.join(booksDir, folder), { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
				.map((entry) => (folder ? `${folder}/${entry.name}` : entry.name))
				.sort();
		} catch {
			return [];
		}
	},
};

const http: HttpFn = async (request) => {
	const response = await fetch(request.url, { method: request.method ?? "GET", headers: request.headers, body: request.body });
	const headers: Record<string, string> = {};
	response.headers.forEach((value, name) => (headers[name] = value));
	return { status: response.status, headers, text: await response.text() };
};

const settings = {
	...DEFAULT_SETTINGS,
	booksFolder: "",
	hardcoverToken: keys.HARDCOVER_API_TOKEN ?? "",
	goodreadsRssUrl: keys.GOODREADS_RSS_BASE ? `${keys.GOODREADS_RSS_BASE}to-read` : "",
	ownerName: process.env.OWNER_NAME ?? "",
};
const ctx: PlanContext = {
	vault: fsVault,
	settings,
	hardcover: createHardcover({ token: settings.hardcoverToken, http }).reader,
	goodreads: new GoodreadsClient({ http }),
	openai: new OpenAiClient({ apiKey: "", model: settings.openaiModel, http }),
};

const only = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((name) => name.trim())) : null;
const run = (name: string) => !only || only.has(name);

let failures = 0;
/** `known`: Python-only items that are a deliberate difference (PLAN.md), listed but not counted as failures */
function compare(name: string, plugin: string[], python: string[], known: (item: string) => boolean = () => false) {
	const p = new Set(plugin);
	const y = new Set(python);
	const onlyPlugin = [...p].filter((x) => !y.has(x));
	const onlyPython = [...y].filter((x) => !p.has(x) && !known(x));
	const expected = [...y].filter((x) => !p.has(x) && known(x));
	const ok = !onlyPlugin.length && !onlyPython.length;
	if (!ok) failures++;
	console.log(`${ok ? "✔" : "✖"} ${name}: ${p.size} item(s)${ok ? "" : ` / Python ${y.size}`}`);
	for (const x of onlyPlugin) console.log(`    only plugin: ${x}`);
	for (const x of onlyPython) console.log(`    only Python: ${x}`);
	for (const x of expected) console.log(`    only Python (known difference): ${x}`);
}

/** `okStatus`: exit codes that mean success (sync_hardcover_labels.py exits 3 when there is nothing to sync) */
function python(args: string[], okStatus = [0]): string {
	const result = spawnSync("python3", args, { cwd: scriptsDir, encoding: "utf8", input: "", timeout: 600_000 });
	if (!okStatus.includes(result.status ?? -1)) {
		throw new Error(`python3 ${args[0]} exited with ${result.status}: ${result.stderr.slice(-500)}`);
	}
	return result.stdout;
}

/** Report sections: a header line ending in ":" followed by "  - item" lines */
function sections(output: string): { header: string; items: string[] }[] {
	const found: { header: string; items: string[] }[] = [];
	for (const line of output.split("\n")) {
		if (line.startsWith("  - ")) {
			found.at(-1)?.items.push(line.slice(4).trim());
		} else if (line.trim().endsWith(":")) {
			found.push({ header: line.trim(), items: [] });
		}
	}
	return found;
}
/** The "  - " lines under the plan note matching `pattern`, prefix kept */
function noteItems(notes: string[], pattern: RegExp): string[] {
	const start = notes.findIndex((n) => pattern.test(n));
	if (start < 0) return [];
	const end = notes.findIndex((n, i) => i > start && !n.startsWith("  - "));
	return notes.slice(start + 1, end < 0 ? undefined : end);
}
const section = (output: string, pattern: RegExp) => sections(output).find((s) => pattern.test(s.header))?.items ?? [];
const pair = (title: string, author: string) => `${unquote(author)} - ${unquote(title)}`;
const rowName = (table: Table, key: Parameters<typeof findRow>[1]) => {
	const row = findRow(table, key);
	return row ? pair(row.cells.Title ?? "?", row.cells.Author ?? "?") : "?";
};

// --- pull: same resulting table, cell by cell
if (run("pull")) {
	console.log("\n== backlog/pullGoodreads");
	const plan = await planPull(ctx, { labelSuggestions: false });
	const memory = new MemoryVault({ [settings.wantToReadFile]: (await fsVault.read(settings.wantToReadFile))! });
	await applyPull({ vault: memory, settings }, selectedChanges(plan));
	const pluginTable = parseTable(memory.files.get(settings.wantToReadFile)!, "Title")!;
	const out = python(["pull_goodreads_to_read.py", "--dry-run", "--no-label-suggestions"]);
	const pyTable = parseTable(out.slice(out.indexOf("Resulting table would be:")), "Title")!;
	const cells = (table: Table) => table.rows.map((r, i) => `${String(i).padStart(3)} ${pyTable.header.map((c) => r.cells[c] ?? "").join(" | ")}`);
	compare("resulting table rows, in order", cells(pluginTable), cells(pyTable));
	const archived = plan.notes.slice(plan.notes.findIndex((n) => /already have a Database/.test(n)) + 1).filter((n) => n.startsWith("  - "));
	compare("already archived", archived.map((n) => n.slice(4)), section(out, /already have a Database\/ note/));
}

// --- link: matched, ambiguous, no match
if (run("link")) {
	console.log("\n== backlog/linkIds");
	const table = await loadBacklog(fsVault, settings);
	const plan = await planLink(ctx);
	const out = python(["link_hardcover_ids.py", "--dry-run"]);
	const name = (key: Parameters<typeof findRow>[1]) => {
		const row = findRow(table, key)!;
		return `${row.cells.Title} (${row.cells.Author})`;
	};
	compare("matched", plan.changes.filter((c) => c.ready).map((c) => `${name(c.payload.key)} -> hardcover_id ${c.payload.bookId}`), section(out, /^Matched:/));
	const waiting = plan.changes.filter((c) => !c.ready);
	compare("ambiguous", waiting.filter((c) => /matches \d+ different/.test(c.summary)).map((c) => `${name(c.payload.key)} isbn=${findRow(table, c.payload.key)!.cells.isbn}`), section(out, /^Ambiguous/));
	compare("no match", waiting.filter((c) => /no Hardcover edition/.test(c.summary)).map((c) => `${name(c.payload.key)} isbn=${findRow(table, c.payload.key)!.cells.isbn}`), section(out, /^No Hardcover edition/));
}

// --- reconcile: the rows to remove, by goodreads_id
if (run("reconcile")) {
	console.log("\n== archive/reconcile");
	const plan = await planReconcile(ctx);
	const out = python(["-c", "import reconcile_promoted as r, id_links\nfor row in r.find_promoted()[4]: print(id_links.extract_id(row.get('goodreads_id', '')))"]);
	compare("rows with a note", plan.changes.map((c) => c.payload.key.goodreadsId ?? "?"), out.split("\n").filter(Boolean));
}

// --- promote: merges, can't check, already archived, promoted, never in the backlog
if (run("promote")) {
	console.log("\n== archive/promote");
	const table = await loadBacklog(fsVault, settings);
	const plan = await planPromote(ctx);
	const out = python(["promote_from_hardcover.py", "--dry-run"]);
	const status = (id: number) => (id === 2 ? "Currently Reading" : "Read");
	const of = (kind: string) => plan.changes.map((c) => c.payload).filter((p) => p.kind === kind);
	compare("stale note ids", of("merge").map((p) => (p.kind === "merge" ? `${p.path.split("/").pop()}: ${p.oldId} -> ${p.newId} (${p.slug})` : "")), section(out, /since merged/));
	const noId = plan.notes.slice(plan.notes.findIndex((n) => /^No hardcover_id yet/.test(n)) + 1).filter((n) => n.startsWith("  - "));
	compare("no hardcover_id", noId.map((n) => n.slice(4)), section(out, /^No hardcover_id yet/).map((i) => i.replace(/^(.*?) - (.*)$/, "$2 ($1)")));
	compare("already archived rows", of("removeRow").map((p) => (p.kind === "removeRow" ? rowName(table, p.key) : "")), section(out, /already have a Database\/ note/).map((i) => i.replace(/ -> [^>]*$/, "")));
	const created = of("create").map((p) => (p.kind === "create" ? { p, text: `${chooseAuthor(p.entry)} - ${chooseTitle(p.entry)} (${status(p.entry.status_id)})` } : null)!);
	compare("promoted", created.filter((c) => c.p.kind === "create" && c.p.row).map((c) => c.text), section(out, /would create a Database\/ note/).map((i) => i.replace(/ \[series: .*\]$/, "")));
	compare("never in the backlog", created.filter((c) => c.p.kind === "create" && !c.p.row).map((c) => c.text), section(out, /no Want to Read\.md row/));
}

// --- finished
if (run("finished")) {
	console.log("\n== archive/finished");
	const notes = new Map((await loadNotes(fsVault, settings)).map((n) => [n.note.path, n.note]));
	const plan = await planFinished(ctx);
	const out = python(["check_finished_from_hardcover.py", "--dry-run"]);
	const items = (pattern: RegExp) => {
		const start = plan.notes.findIndex((n) => pattern.test(n));
		if (start < 0) return [];
		const end = plan.notes.findIndex((n, i) => i > start && !n.startsWith("  - "));
		return plan.notes.slice(start + 1, end < 0 ? undefined : end).map((n) => n.slice(4));
	};
	const unq = (item: string) => item.split(" - ").map((part) => unquote(part)).join(" - ");
	compare("blank dateRead, no hardcover_id", items(/no hardcover_id \(can't check\)/), section(out, /no hardcover_id \(can't check\)/).map(unq));
	compare("no user book", items(/no matching book/), section(out, /no matching Hardcover user_books/).map(unq));
	compare("not Read yet", items(/not marked Read/), section(out, /still not marked Read/).map(unq));
	compare(
		"stale note ids",
		plan.changes.map((c) => c.payload).flatMap((p) => (p.kind === "merge" ? [`${pair(notes.get(p.path)!.title, notes.get(p.path)!.author)}: ${p.oldId} -> ${p.newId} (${p.slug})`] : [])),
		section(out, /merged into a/).map(unq),
	);
	compare(
		"finished",
		plan.changes.map((c) => c.payload).flatMap((p) => (p.kind === "finished" ? [`${pair(notes.get(p.path)!.title, notes.get(p.path)!.author)}: dateRead -> ${p.dateRead}, rating_10 -> ${p.rating10 ?? "(none)"}`] : [])),
		section(out, /finished on Hardcover:/).map((i) => unq(i.replace(/ \[missing on Hardcover: .*\]$/, ""))),
	);
}

// --- push: rows to push, possible duplicates. The plugin checks merged ids as the winner, the Python doesn't
if (run("push")) {
	console.log("\n== backlog/push");
	const plan = await planPush(ctx);
	const out = python(["push_want_to_read_to_hardcover.py", "--dry-run"]);
	const title = (name: string) => name.replace(/ \([^()]*\)$/, "");
	compare("to push", plan.changes.map((c) => `${title(c.payload.name)} (hardcover_id=${c.payload.bookId})`), section(out, /^Would push:/));
	const dupes = noteItems(plan.notes, /^Possible duplicates/);
	compare(
		"possible duplicates",
		dupes.map((n) => n.replace(/^  - (.*) \([^()]*\): row's hardcover_id (\d+), already tracked as (.*)$/, (_, t, id, ids) => `${t}: row's hardcover_id=${id}, already tracked as ${ids.replace(/ \([^)]*\)/g, "")}`)),
		section(out, /^Possible duplicates/),
	);
	const counts = (text: string) => /(\d+) already .*?(\d+) (?:have no|without a) hardcover_id/.exec(text)?.slice(1).join("/");
	compare("already tracked / no id counts", [counts(plan.notes[0]) ?? "?"], [counts(out.split("\n")[1]) ?? "?"]);
}

// --- labels: stale ids, new lists, pulls, pushes, owned field, strays. The Python's dry run neither looks up nor
// creates lists, so pulls and pushes for labels with no mapping yet are left out of the comparison
if (run("labels")) {
	console.log("\n== labels/sync");
	const table = await loadBacklog(fsVault, settings);
	const notes = new Map((await loadNotes(fsVault, settings)).map((n) => [n.note.path, n.note]));
	const plan = await planLabels(ctx);
	const out = python(["sync_hardcover_labels.py", "--dry-run"], [0, 3]);
	const titleOf = (target: { kind: "row"; key: Parameters<typeof findRow>[1] } | { kind: "note"; path: string }) =>
		target.kind === "row" ? findRow(table, target.key)?.cells.Title ?? "?" : unquote(notes.get(target.path)?.title ?? "?");
	const payloads = plan.changes.map((c) => c.payload);
	const newLists = new Set(payloads.flatMap((p) => (p.kind === "list" ? [p.label.toLowerCase()] : [])));
	const leftAlone = noteItems(plan.notes, /^Labels left alone/);
	const created = /Would create \d+ new Hardcover list\(s\) for: (.*)$/m.exec(out)?.[1].split(", ") ?? [];
	compare("new lists", [...newLists, ...leftAlone.map((n) => n.slice(4).split(":")[0].toLowerCase())], created.map((l) => l.toLowerCase()));
	compare(
		"stale ids",
		payloads.flatMap((p) =>
			p.kind === "mergeRow" ? [`${findRow(table, p.key)?.cells.Title}: ${p.oldId} -> ${p.newId} (${p.slug})`]
			: p.kind === "merge" ? [`${unquote(notes.get(p.path)!.title)}: ${p.oldId} -> ${p.newId} (${p.slug})`] : []),
		section(out, /merged into a different canonical book/).map((i) => unquote(i.replace(/ \((Want to Read\.md|[^()]*\.md)\):/, ":"))),
	);
	// Known difference: the Python counts its own planned pushes as list membership, so a label pushed from a row is
	// pulled into a note of the same book in the same run. The plugin pulls only from real members (next run)
	const merged = new Map(payloads.flatMap((p) => (p.kind === "mergeRow" ? [[p.oldId, String(p.newId)] as const] : [])));
	const idsOf = (title: string) => new Set([
		...[...notes.values()].filter((n) => unquote(n.title) === title).map((n) => n.hardcoverId),
		...table.rows.filter((r) => r.cells.Title === title).map((r) => rowHardcoverId(r)).map((id) => merged.get(id ?? "") ?? id),
	]);
	const pushedHere = (item: string) => {
		const [, title, label] = /^(.*): \+(.*)$/.exec(item) ?? [];
		const ids = idsOf(title ?? "");
		return payloads.some((p) => p.kind === "push" && p.label === label && ids.has(String(p.bookId)));
	};
	compare(
		"pulled labels",
		payloads.flatMap((p) => (p.kind === "pull" && p.field === "labels" && !newLists.has(p.value.toLowerCase()) ? [`${titleOf(p.target)}: +${p.value}`] : [])),
		section(out, /^Would pull/).map(unquote),
		pushedHere,
	);
	compare(
		"pushed labels",
		payloads.flatMap((p) => (p.kind === "push" && p.sources[0].from !== "owned" && !newLists.has(p.labelKey) ? [`${titleOf(p.sources[0].target)}: +${p.label}`] : [])),
		section(out, /^Would push \d+ book/).map(unquote),
	);
	compare("owner added to owned", payloads.flatMap((p) => (p.kind === "pull" && p.field === "owned" ? [titleOf(p.target)] : [])), section(out, /to the `owned` field/).map(unquote));
	compare("pushed to owned", payloads.flatMap((p) => (p.kind === "push" && p.sources[0].from === "owned" ? [titleOf(p.sources[0].target)] : [])), section(out, /into Hardcover's 'owned' list/).map(unquote));
	const stripped = /Would strip leftover .*?: (.*)$/m.exec(out)?.[1].split(", ") ?? [];
	compare("stray owned in labels", payloads.flatMap((p) => (p.kind === "strip" ? [unquote(notes.get(p.path)!.title)] : [])), stripped.map(unquote));
	const skipped = /(\d+) Want to Read\.md row\(s\) and (\d+) Database\/ note\(s\) skipped \(no hardcover_id\)\. (\d+) Database/.exec(out)?.slice(1).join("/");
	const ours = /(\d+) backlog row\(s\) and (\d+) note\(s\) skipped \(no hardcover_id\), (\d+) note/.exec(plan.notes[0])?.slice(1).join("/");
	compare("skipped counts (rows no id / notes no id / notes no labels)", [ours ?? "?"], [skipped ?? "?"]);
}

console.log(failures ? `\n${failures} comparison(s) differ` : "\nAll comparisons match");
process.exit(failures ? 1 : 0);
