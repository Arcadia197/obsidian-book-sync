// Markdown pipe tables (Want to Read.md, Hardcover Lists.md), edited as lines of text.
// - Column order always comes from the file's header row, never a hardcoded list (a hardcoded list once drifted
//   and dropped every isbn on rewrite)
// - Rows nobody changed keep their exact original line, and everything outside the table is left alone
// - A row whose cell count doesn't match the header (e.g. a stray "|" in Notes) is kept verbatim and can't be edited

export interface TableRow {
	/** Cell values by header name, trimmed */
	cells: Record<string, string>;
	/** The row's line as read from the file; null once edited, or for a new row */
	original: string | null;
	/** Cell count differs from the header: kept as is, never edited */
	malformed: boolean;
}

export interface Table {
	/** The whole file, split on "\n" */
	lines: string[];
	headerIdx: number;
	/** First line after the table */
	endIdx: number;
	header: string[];
	rows: TableRow[];
}

/** Cells of a table line: outer pipes dropped, split on unescaped "|", trimmed. `\|` stays inside its cell */
export function splitRow(line: string): string[] {
	let s = line.trim();
	while (s.startsWith("|")) {
		s = s.slice(1);
	}
	while (s.endsWith("|") && !s.endsWith("\\|")) {
		s = s.slice(0, -1);
	}
	const cells: string[] = [];
	let current = "";
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "\\" && s[i + 1] === "|") {
			current += "\\|";
			i++;
		} else if (s[i] === "|") {
			cells.push(current.trim());
			current = "";
		} else {
			current += s[i];
		}
	}
	cells.push(current.trim());
	return cells;
}

/**
 * The first table whose header row contains `marker` (e.g. "Title"), or null if there is none.
 * The table runs from the header through every following line that starts with "|".
 */
export function parseTable(text: string, marker: string): Table | null {
	const lines = text.split("\n");
	const headerIdx = lines.findIndex((line) => line.trim().startsWith("|") && line.includes(marker));
	if (headerIdx < 0) {
		return null;
	}
	let endIdx = Math.min(headerIdx + 2, lines.length);
	while (endIdx < lines.length && lines[endIdx].trim().startsWith("|")) {
		endIdx++;
	}
	const header = splitRow(lines[headerIdx]);
	const rows = lines.slice(headerIdx + 2, endIdx).map((line): TableRow => {
		const values = splitRow(line);
		const cells: Record<string, string> = {};
		header.forEach((column, i) => {
			cells[column] = values[i] ?? "";
		});
		return { cells, original: line, malformed: values.length !== header.length };
	});
	return { lines, headerIdx, endIdx, header, rows };
}

/** One table line, cells in header order */
export function renderRow(header: string[], cells: Record<string, string>): string {
	return `| ${header.map((column) => cells[column] ?? "").join(" | ")} |`;
}

/** The file with the table's rows as they are now: unchanged rows byte for byte, edited and new rows re-rendered */
export function serializeTable(table: Table): string {
	const rowLines = table.rows.map((row) => row.original ?? renderRow(table.header, row.cells));
	return [
		...table.lines.slice(0, Math.min(table.headerIdx + 2, table.endIdx)),
		...rowLines,
		...table.lines.slice(table.endIdx),
	].join("\n");
}

/** A value that is safe inside a cell: no line breaks, "|" escaped */
export function cellValue(value: string): string {
	return value
		.replace(/\s*[\r\n]+\s*/g, " ")
		.replace(/\\?\|/g, "\\|")
		.trim();
}

/** Sets one cell. Throws for a malformed row or an unknown column, since writing there would corrupt the row */
export function setCell(table: Table, row: TableRow, column: string, value: string): void {
	if (row.malformed) {
		throw new Error(`Can't edit a row whose cell count doesn't match the header: ${row.original}`);
	}
	if (!table.header.includes(column)) {
		throw new Error(`The table has no "${column}" column`);
	}
	const safe = cellValue(value);
	if (row.cells[column] !== safe) {
		row.cells[column] = safe;
		row.original = null;
	}
}

/** Appends a row; columns not given stay blank */
export function addRow(table: Table, values: Record<string, string>): TableRow {
	const cells: Record<string, string> = {};
	for (const column of table.header) {
		cells[column] = cellValue(values[column] ?? "");
	}
	const row: TableRow = { cells, original: null, malformed: false };
	table.rows.push(row);
	return row;
}

/** Newest first by a date-like column; rows with equal values keep their order (same as Python's stable sort) */
export function sortRowsDesc(table: Table, column: string): void {
	table.rows.sort((a, b) => {
		const x = a.cells[column] ?? "";
		const y = b.cells[column] ?? "";
		return x < y ? 1 : x > y ? -1 : 0;
	});
}

/** A comma-separated cell (Labels, Genre) as a list, blanks dropped */
export function splitList(cell: string): string[] {
	return cell
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

export function joinList(values: string[]): string {
	return values.join(", ");
}
