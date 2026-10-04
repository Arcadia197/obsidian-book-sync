// Read-only check of the core parsers against a real Books folder (BOOKS_DIR). Writes nothing anywhere.
// Prints counts and file names only, no note content.
import { readdirSync, readFileSync } from "fs";
import * as path from "path";
import { parseTable, renderRow, serializeTable } from "../../src/core/table";
import { extractId } from "../../src/core/idLinks";
import { labelGuidance, parseListsMapping } from "../../src/core/listsMapping";
import { readDatabaseNote, setLabels, setOwned, stillNeededFields } from "../../src/core/databaseNote";
import { frontmatterRange } from "../../src/core/frontmatter";

const booksDir = process.env.BOOKS_DIR!;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (!ok) failures++;
	console.log(`${ok ? "✔" : "✖"} ${name}${detail ? `\n    ${detail}` : ""}`);
}
const info = (text: string) => console.log(`  ${text}`);

// --- Want to Read.md
const wantText = readFileSync(path.join(booksDir, "Want to Read.md"), "utf8");
const want = parseTable(wantText, "Title");
check("Want to Read.md: table found", want !== null);
if (want) {
	check("Want to Read.md: parse + serialize is byte-identical", serializeTable(want) === wantText);
	info(`columns: ${want.header.join(", ")}`);
	info(`${want.rows.length} rows`);
	const malformed = want.rows.filter((r) => r.malformed);
	check("Want to Read.md: no row with a cell count that differs from the header", malformed.length === 0, malformed.map((r) => r.cells.Title).join(", "));
	const unkeyed = want.rows.filter((r) => !extractId(r.cells.goodreads_id ?? ""));
	info(`${unkeyed.length} row(s) without a goodreads_id${unkeyed.length ? `: ${unkeyed.map((r) => r.cells.Title).join(", ")}` : ""}`);
	// Python's full rewrite re-renders every row as "| a | b |": rows that differ would change on the first rewrite
	const reformatted = want.rows.filter((r) => renderRow(want.header, r.cells) !== r.original);
	info(`${reformatted.length} row(s) a Python-style full re-render would reformat`);
}

// --- Hardcover Lists.md
const listsText = readFileSync(path.join(booksDir, "Hardcover Lists.md"), "utf8");
const mapping = parseListsMapping(listsText);
check("Hardcover Lists.md: mapping table found", mapping !== null);
if (mapping) {
	check("Hardcover Lists.md: parse + serialize is byte-identical", serializeTable(mapping.table) === listsText);
	info(`${mapping.mapped.size} mapped labels, ${mapping.table.rows.length - mapping.mapped.size - mapping.unreadable.length} list(s) left alone`);
	check("Hardcover Lists.md: every mapped row has a readable list id", mapping.unreadable.length === 0, mapping.unreadable.join(", "));
	const guidance = labelGuidance(listsText);
	check("Hardcover Lists.md: label guidance section found", guidance.length > 0, `${guidance.length} characters`);
}

// --- Database/ notes
const dbDir = path.join(booksDir, "Database");
const files = readdirSync(dbDir).filter((f) => f.endsWith(".md")).sort();
info(`${files.length} Database/ notes`);
const problems: Record<string, string[]> = {
	"no frontmatter": [],
	"labels block not byte-identical after re-render": [],
	"owned block not byte-identical after re-render": [],
	"no hardcover_id": [],
	"no labels field": [],
	"goodreads_id field differs from the first Goodreads URL in the note (what the Python reads)": [],
	"hardcover_id differs from the Python regex": [],
};
const pythonNeeded: string[] = [];
let ownedMulti = 0;
for (const file of files) {
	const text = readFileSync(path.join(dbDir, file), "utf8");
	if (!frontmatterRange(text)) {
		problems["no frontmatter"].push(file);
		continue;
	}
	const note = readDatabaseNote(file, text);
	if (note.labels !== null && setLabels(text, note.labels) !== text) problems["labels block not byte-identical after re-render"].push(file);
	if (setOwned(text, note.owned) !== text) problems["owned block not byte-identical after re-render"].push(file);
	if (!note.hardcoverId) problems["no hardcover_id"].push(file);
	if (note.labels === null) problems["no labels field"].push(file);
	if (note.owned.length > 1) ownedMulti++;
	const pyGoodreads = /goodreads\.com\/book\/show\/(\d+)/.exec(text)?.[1] ?? null;
	if (pyGoodreads !== note.goodreadsId) problems["goodreads_id field differs from the first Goodreads URL in the note (what the Python reads)"].push(file);
	const pyHardcover = /^hardcover_id:\s*(\d+)\s*$/m.exec(text)?.[1] ?? null;
	if (pyHardcover !== note.hardcoverId) problems["hardcover_id differs from the Python regex"].push(file);
	// check_finished_from_hardcover.py's list-field rule: a scalar language_read counts as blank there
	const pyLanguageBlank = /^language_read:.*(?:\n {2}-.*)*\n/m.exec(text) && !/^language_read:(?:.*)\n {2}- /m.test(text);
	if (pyLanguageBlank && !stillNeededFields(text).includes("language_read")) pythonNeeded.push(file);
}
for (const [problem, list] of Object.entries(problems)) {
	const isRoundTrip = problem.includes("byte-identical") || problem === "no frontmatter";
	check(`Database/: ${problem}: ${list.length}`, !isRoundTrip || list.length === 0, list.slice(0, 10).join(", "));
}
info(`${ownedMulti} note(s) with several owners`);
info(`${pythonNeeded.length} note(s) where the Python would flag a filled scalar language_read as blank (the port doesn't)`);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll round-trip checks passed");
process.exit(failures ? 1 : 0);
