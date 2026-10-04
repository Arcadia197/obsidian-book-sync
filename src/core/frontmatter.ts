// Frontmatter edits as text, the way the Python scripts do them: only the touched key's lines change, every other
// byte of the note stays as it was. (Obsidian's processFrontMatter would reformat the YAML of every note it touches.)
// A key's "block" is its own line plus any `  - item` lines right below it.

export interface Range {
	start: number;
	end: number;
}

/** The frontmatter between the opening and closing `---` lines (ends with "\n" unless empty), or null if there is none */
export function frontmatterRange(text: string): Range | null {
	if (!text.startsWith("---\n")) {
		return null;
	}
	let idx = 4;
	while (idx <= text.length) {
		const newline = text.indexOf("\n", idx);
		const line = text.slice(idx, newline < 0 ? text.length : newline);
		if (/^---[ \t]*$/.test(line)) {
			return { start: 4, end: idx };
		}
		if (newline < 0) {
			return null;
		}
		idx = newline + 1;
	}
	return null;
}

interface Block extends Range {
	/** Text after `key:` on the key's own line, trimmed */
	value: string;
	/** Raw text of each `  - item` line below the key */
	items: string[];
}

function findBlock(text: string, key: string): Block | null {
	const fm = frontmatterRange(text);
	if (!fm) {
		return null;
	}
	const prefix = `${key}:`;
	let idx = fm.start;
	while (idx < fm.end) {
		const lineEnd = text.indexOf("\n", idx) + 1;
		const line = text.slice(idx, lineEnd - 1);
		if (line.startsWith(prefix)) {
			const items: string[] = [];
			let end = lineEnd;
			while (end < fm.end) {
				const next = text.slice(end, text.indexOf("\n", end));
				const item = /^ {2}-(?: (.*))?$/.exec(next);
				if (!item) {
					break;
				}
				items.push(item[1] ?? "");
				end += next.length + 1;
			}
			return { start: idx, end, value: line.slice(prefix.length).trim(), items };
		}
		idx = lineEnd;
	}
	return null;
}

/** Replaces the key's block with `rendered`, or appends it at the end of the frontmatter if the key is missing */
function replaceBlock(text: string, key: string, rendered: string): string {
	const block = findBlock(text, key);
	if (block) {
		return text.slice(0, block.start) + rendered + text.slice(block.end);
	}
	const fm = frontmatterRange(text);
	if (!fm) {
		throw new Error(`The note has no frontmatter to add "${key}" to`);
	}
	return text.slice(0, fm.end) + rendered + text.slice(fm.end);
}

/** Without surrounding double or single quotes */
export function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.endsWith(trimmed[0])) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export function hasField(text: string, key: string): boolean {
	return findBlock(text, key) !== null;
}

/** The raw value after `key:` (quotes kept, "" when blank), or null if the key is missing */
export function getField(text: string, key: string): string | null {
	return findBlock(text, key)?.value ?? null;
}

/** Sets `key: value` (`key:` when value is blank); a list under the key is replaced too */
export function setField(text: string, key: string, value: string | number): string {
	const rendered = String(value) === "" ? `${key}:\n` : `${key}: ${value}\n`;
	return replaceBlock(text, key, rendered);
}

/**
 * The values of a list key, as written (quotes kept): `  - a` lines, a flow list `[a, b]`, or a single scalar
 * (`owned: Julius`). Blank and `[]` give an empty list; a missing key gives null.
 */
export function getList(text: string, key: string): string[] | null {
	const block = findBlock(text, key);
	if (!block) {
		return null;
	}
	if (block.items.length > 0) {
		return block.items;
	}
	const value = block.value;
	if (value.startsWith("[") && value.endsWith("]")) {
		return value
			.slice(1, -1)
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	}
	return value ? [value] : [];
}

export interface ListStyle {
	/** How an empty list is written: `key: []` or a blank `key:` */
	empty: "[]" | "blank";
	/** One value is written as a scalar (`owned: Julius`), not a one-item list */
	singleAsScalar: boolean;
}

/** `labels` in Database/ notes: `labels: []` when empty, always a block list otherwise */
export const LABELS_STYLE: ListStyle = { empty: "[]", singleAsScalar: false };
/** `owned` in Database/ notes: blank when empty, a scalar for one name, a list only for several */
export const OWNED_STYLE: ListStyle = { empty: "blank", singleAsScalar: true };

export function renderList(key: string, values: string[], style: ListStyle): string {
	if (values.length === 0) {
		return style.empty === "[]" ? `${key}: []\n` : `${key}:\n`;
	}
	if (values.length === 1 && style.singleAsScalar) {
		return `${key}: ${values[0]}\n`;
	}
	return `${key}:\n${values.map((value) => `  - ${value}\n`).join("")}`;
}

export function setList(text: string, key: string, values: string[], style: ListStyle): string {
	return replaceBlock(text, key, renderList(key, values, style));
}
