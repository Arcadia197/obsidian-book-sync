// What the review window says about each step and phase. Phase order and gates as in sync_books.py: backlog
// (pull -> link -> push), labels, archive (promote -> reconcile -> finished).

import type { StepId } from "../core/changes";

export interface StepInfo {
	name: string;
	/** For the step bar and the status bar */
	short: string;
	phase: PhaseId;
	desc: string;
	/** Shown while plan() runs, without the trailing dots */
	loading: string;
}

export type PhaseId = "backlog" | "labels" | "archive";

export interface PhaseInfo {
	id: PhaseId;
	name: string;
	/** Where the data goes, for the start page */
	flow: string;
	steps: StepId[];
}

export const PHASES: PhaseInfo[] = [
	{ id: "backlog", name: "Backlog", flow: "Goodreads → Want to Read → Hardcover", steps: ["backlog/pullGoodreads", "backlog/linkIds", "backlog/push"] },
	{ id: "labels", name: "Labels", flow: "Your labels ⇄ Hardcover lists", steps: ["labels/sync"] },
	{ id: "archive", name: "Archive", flow: "Hardcover → notes in Database", steps: ["archive/promote", "archive/reconcile", "archive/finished"] },
];

export const FULL_SYNC: StepId[] = PHASES.flatMap((phase) => phase.steps);

export const STEP_INFO: Record<StepId, StepInfo> = {
	"backlog/pullGoodreads": {
		name: "Pull from Goodreads",
		short: "Pull",
		phase: "backlog",
		desc: "New books on your Goodreads to-read shelf, and fresh dates for books already in Want to Read.",
		loading: "Reading your Goodreads to-read shelf",
	},
	"backlog/linkIds": {
		name: "Link Hardcover ids",
		short: "Link",
		phase: "backlog",
		desc: "Finds rows on Hardcover by their isbn. Only a unique match is linked; anything else waits for you.",
		loading: "Looking up isbns on Hardcover",
	},
	"backlog/push": {
		name: "Push to Hardcover",
		short: "Push",
		phase: "backlog",
		desc: "Adds linked rows to your Hardcover Want to Read shelf. Nothing goes to Hardcover unless you tick it.",
		loading: "Checking which books Hardcover already tracks",
	},
	"labels/sync": {
		name: "Sync labels",
		short: "Labels",
		phase: "labels",
		desc: "Two-way and additive: books on a Hardcover list get its label in your vault, labels in your vault put books on the list. Nothing is removed.",
		loading: "Reading your Hardcover lists and their books",
	},
	"archive/promote": {
		name: "Create notes",
		short: "Promote",
		phase: "archive",
		desc: "Books you started or finished on Hardcover get a note in Database and leave Want to Read.",
		loading: "Checking the reading status of your backlog",
	},
	"archive/reconcile": {
		name: "Clean up the backlog",
		short: "Reconcile",
		phase: "archive",
		desc: "Removes backlog rows whose book already has a note.",
		loading: "Comparing Want to Read with Database",
	},
	"archive/finished": {
		name: "Finished books",
		short: "Finished",
		phase: "archive",
		desc: "Notes of books you finished on Hardcover get dateRead, your rating and your review. Hardcover wins for these.",
		loading: "Checking notes with a blank dateRead",
	},
	"backlog/addBook": {
		name: "Add to Want to Read",
		short: "Add",
		phase: "backlog",
		desc: "One Goodreads book as a new row in Want to Read.",
		loading: "Reading the Goodreads page",
	},
};

export function phaseOf(id: StepId): PhaseInfo {
	return PHASES.find((phase) => phase.id === STEP_INFO[id].phase)!;
}
