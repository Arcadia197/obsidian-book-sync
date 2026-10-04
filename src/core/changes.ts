// What every pipeline step hands to the review window: plan() reads and returns a Plan, apply() writes only the
// changes the user left ticked. Replaces the Python's --dry-run and its input() prompts.
// Files are reached through VaultReader/VaultWriter, so the steps run on Obsidian's vault, in memory (tests) or on
// a read-only folder (parity script) alike.

export type StepId = "backlog/pullGoodreads" | "backlog/linkIds" | "archive/promote" | "archive/reconcile" | "archive/finished";

/** An editable field next to a change: labels for a new row, a pasted Hardcover link, a Goodreads id */
export interface ChangeInput {
	kind: "labels" | "hardcoverLink" | "goodreadsId";
	/** What to enter, for the review window */
	prompt: string;
	value: string;
}

export interface Change<P = unknown> {
	/** Unique within its plan */
	id: string;
	summary: string;
	/** Extra lines shown under the summary (field changes, still-needs-by-hand) */
	details: string[];
	/** Shown next to the item: missing edition, backlog Notes, a guess that needs review */
	warnings: string[];
	writesHardcover: boolean;
	/** Ticked; the default is set by plan() */
	selected: boolean;
	/** False while the change still waits for input; apply() skips it */
	ready: boolean;
	input?: ChangeInput;
	/** Step-specific; only apply() reads it */
	payload: P;
}

export interface Plan<P = unknown> {
	step: StepId;
	changes: Change<P>[];
	/** Report lines that need no decision: already archived, can't check, still reading */
	notes: string[];
}

export interface ApplyResult {
	applied: string[];
	skipped: { id: string; reason: string }[];
	/** Reminders after writing, e.g. "update Goodreads by hand" */
	messages: string[];
}

export function emptyResult(): ApplyResult {
	return { applied: [], skipped: [], messages: [] };
}

/** The changes apply() should get: ticked and not waiting for input */
export function selectedChanges<P>(plan: Plan<P>): Change<P>[] {
	return plan.changes.filter((change) => change.selected && change.ready);
}

export interface VaultReader {
	/** The file's text, or null if there is no such file */
	read(path: string): Promise<string | null>;
	/** Paths of the .md files directly inside `folder` (not in subfolders), sorted; empty if the folder is missing */
	listNotes(folder: string): Promise<string[]>;
}

export interface VaultWriter extends VaultReader {
	/** Atomic read-modify-write of an existing file; returns the new text. Throws if the file is missing */
	process(path: string, fn: (text: string) => string): Promise<string>;
	/** Creates a new file (and its folder). Throws if it already exists */
	create(path: string, text: string): Promise<void>;
}
