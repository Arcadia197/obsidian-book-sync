// One change as a card in the review window: tick, summary, result, details, warnings and its input (label chips,
// a pasted Hardcover link, a Goodreads id). The view owns the state; cards only render it and report back.

import { Notice, setIcon } from "obsidian";
import type { ApplyResult, Change } from "../core/changes";
import { joinList, splitList } from "../core/table";

export interface CardHost {
	/** False once the step is applying or applied: nothing can be ticked or typed anymore */
	editable: boolean;
	/** Phones fold details away behind a "Details" button */
	compact: boolean;
	result: ApplyResult | null;
	isOpen(id: string): boolean;
	toggleOpen(id: string): void;
	/** Ticks or unticks, with the changes that depend on it */
	setSelected(change: Change, selected: boolean): void;
	/** Re-renders the step, focusing the field of `focusId` afterwards */
	refresh(focusId?: string): void;
	/** Paste field: looks the link up; the message to show next to it */
	resolveLink(change: Change): Promise<string>;
	/** A link to a vault file with hover preview */
	fileLink(parent: HTMLElement, path: string, text: string): void;
}

/** Last lookup message per change id, so a re-render keeps it */
const lookupMessages = new Map<string, { text: string; ok: boolean }>();
const lookupTimers = new Map<string, number>();
const lookupRuns = new Map<string, number>();

export function renderCard(parent: HTMLElement, change: Change, host: CardHost): HTMLElement {
	const card = parent.createDiv({ cls: "book-sync-card" });
	card.dataset.changeId = change.id;
	card.toggleClass("is-hardcover", change.writesHardcover);
	card.toggleClass("is-selected", change.selected && change.ready);
	card.toggleClass("is-waiting", !change.ready);
	card.toggleClass("is-locked", !host.editable);

	const tick = card.createEl("input", { type: "checkbox", cls: "book-sync-tick" });
	tick.checked = change.selected && change.ready;
	tick.disabled = !host.editable || !change.ready;
	tick.setAttr("aria-label", "Apply this change");
	tick.addEventListener("change", () => host.setSelected(change, tick.checked));

	const main = card.createDiv({ cls: "book-sync-card-main" });
	const summary = main.createDiv({ cls: "book-sync-summary" });
	summary.createSpan({ text: change.summary });
	if (change.writesHardcover) {
		const badge = summary.createSpan({ cls: "book-sync-badge" });
		setIcon(badge.createSpan(), "cloud");
		badge.createSpan({ text: "Hardcover" });
	}
	if (change.file) {
		host.fileLink(summary, change.file, "Open note");
	}

	renderResult(main, change, host.result);

	if (change.details.length) {
		const open = !host.compact || host.isOpen(change.id);
		if (open) {
			const list = main.createEl("ul", { cls: "book-sync-details" });
			change.details.forEach((line) => list.createEl("li", { text: line }));
		}
		if (host.compact) {
			const more = main.createEl("button", { cls: "book-sync-link-button", text: open ? "Hide details" : "Details" });
			more.addEventListener("click", () => host.toggleOpen(change.id));
		}
	}
	for (const warning of change.warnings) {
		const box = main.createDiv({ cls: "book-sync-warning" });
		setIcon(box.createSpan(), "alert-triangle");
		box.createSpan({ text: warning });
	}
	if (change.input) {
		if (host.editable) {
			renderInput(main, change, host);
		} else if (change.input.value) {
			main.createEl("ul", { cls: "book-sync-details" }).createEl("li", { text: `${inputName(change)}: ${change.input.value}` });
		}
	}

	// Tapping anywhere on the card ticks it, except on its links, buttons and fields
	card.addEventListener("click", (event) => {
		const target = event.target as HTMLElement;
		if (!host.editable || target.closest("input, button, a, textarea, .book-sync-field")) {
			return;
		}
		if (!change.ready) {
			new Notice("Fill in the field first.");
			return;
		}
		host.setSelected(change, !change.selected);
	});
	return card;
}

function inputName(change: Change): string {
	return change.input?.kind === "labels" ? "Labels" : change.input?.kind === "hardcoverLink" ? "Hardcover link" : "Goodreads id";
}

function renderResult(parent: HTMLElement, change: Change, result: ApplyResult | null): void {
	if (!result) {
		return;
	}
	const skipped = result.skipped.find((s) => s.id === change.id);
	let cls = "is-none";
	let icon = "minus";
	let text = change.ready ? "Not ticked, left as is" : "Waiting for input, left as is";
	if (result.applied.includes(change.id)) {
		cls = "is-ok";
		icon = "check";
		text = change.writesHardcover ? "Sent to Hardcover" : "Written";
	} else if (skipped) {
		cls = "is-skipped";
		icon = "alert-triangle";
		text = `Skipped: ${skipped.reason}`;
	} else if (change.selected && change.ready) {
		// Ticked but neither applied nor skipped: the step wrote nothing for it
		text = "Not written";
	}
	const line = parent.createDiv({ cls: `book-sync-result ${cls}` });
	setIcon(line.createSpan(), icon);
	line.createSpan({ text });
}

function renderInput(parent: HTMLElement, change: Change, host: CardHost): void {
	const input = change.input!;
	const field = parent.createDiv({ cls: "book-sync-field" });
	if (input.kind === "labels") {
		renderLabels(field, change, host);
		return;
	}
	const label = field.createDiv({ cls: "book-sync-field-label" });
	setIcon(label.createSpan(), "link");
	label.createSpan({ text: input.kind === "hardcoverLink" ? "Paste the Hardcover link of the right book, or leave blank to skip" : input.prompt });
	const box = field.createEl("input", {
		type: "text",
		cls: "book-sync-text",
		attr: { autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: input.kind === "hardcoverLink" ? "hardcover.app/books/…" : "goodreads.com/book/show/…" },
	});
	box.dataset.focusId = change.id;
	box.value = input.value;
	if (input.kind === "goodreadsId") {
		box.addEventListener("input", () => (input.value = box.value));
		return;
	}
	const status = field.createDiv({ cls: "book-sync-lookup" });
	const shown = lookupMessages.get(change.id);
	if (shown) {
		status.setText(shown.text);
		status.toggleClass("is-ok", shown.ok);
	}
	box.addEventListener("input", () => {
		input.value = box.value;
		window.clearTimeout(lookupTimers.get(change.id));
		// Ready only once the lookup found exactly one book; anything typed since makes it wait again
		const run = (lookupRuns.get(change.id) ?? 0) + 1;
		lookupRuns.set(change.id, run);
		const wasReady = change.ready;
		change.ready = false;
		change.selected = false;
		lookupMessages.delete(change.id);
		status.setText(box.value.trim() ? "Looking it up on Hardcover…" : "");
		status.removeClass("is-ok");
		if (wasReady) {
			host.refresh(change.id);
		}
		if (!box.value.trim()) {
			return;
		}
		lookupTimers.set(
			change.id,
			window.setTimeout(async () => {
				let text: string;
				try {
					text = await host.resolveLink(change);
				} catch (err) {
					text = `Lookup failed: ${(err as Error).message}`;
				}
				if (lookupRuns.get(change.id) !== run) {
					return;
				}
				lookupMessages.set(change.id, { text, ok: change.ready });
				host.refresh(change.id);
			}, 700),
		);
	});
}

/** Label chips: suggestions from the vocabulary, Enter or comma adds, Backspace on an empty field removes the last */
function renderLabels(field: HTMLElement, change: Change, host: CardHost): void {
	const input = change.input!;
	const options = input.options ?? [];
	const label = field.createDiv({ cls: "book-sync-field-label" });
	setIcon(label.createSpan(), "sparkles");
	label.createSpan({ text: options.length ? "Labels · only labels you already use" : "Labels" });

	const chips = field.createDiv({ cls: "book-sync-chips" });
	const current = () => splitList(input.value);
	const save = (labels: string[]) => {
		input.value = joinList(labels);
		host.refresh(change.id);
	};
	for (const value of current()) {
		const chip = chips.createSpan({ cls: "book-sync-chip", text: value });
		const remove = chip.createEl("button", { attr: { "aria-label": `Remove ${value}` } });
		setIcon(remove, "x");
		remove.addEventListener("click", () => save(current().filter((l) => l !== value)));
	}
	const entry = chips.createEl("input", {
		type: "text",
		cls: "book-sync-chip-input",
		attr: { autocomplete: "off", autocapitalize: "off", placeholder: current().length ? "add" : "add a label" },
	});
	entry.dataset.focusId = change.id;
	chips.addEventListener("click", (event) => {
		if (event.target === chips) entry.focus();
	});
	const suggestions = field.createDiv({ cls: "book-sync-suggestions" });

	const add = (typed: string) => {
		const wanted = typed.trim();
		if (!wanted) {
			return;
		}
		const known = options.length ? options.find((o) => o.toLowerCase() === wanted.toLowerCase()) : wanted;
		if (!known) {
			new Notice(`"${wanted}" isn't one of your labels yet. Labels come from the labels field of your Database notes.`);
			return;
		}
		if (!current().some((l) => l.toLowerCase() === known.toLowerCase())) {
			save([...current(), known]);
		} else {
			entry.value = "";
		}
	};
	entry.addEventListener("input", () => {
		suggestions.empty();
		const query = entry.value.trim().toLowerCase();
		if (!query) {
			return;
		}
		const have = new Set(current().map((l) => l.toLowerCase()));
		const hits = options.filter((o) => o.toLowerCase().includes(query) && !have.has(o.toLowerCase())).slice(0, 6);
		for (const hit of hits) {
			const button = suggestions.createEl("button", { text: `+ ${hit}` });
			button.addEventListener("click", () => add(hit));
		}
		if (options.length && !hits.length) {
			suggestions.createSpan({ cls: "book-sync-muted", text: `"${entry.value.trim()}" isn't one of your labels` });
		}
	});
	entry.addEventListener("keydown", (event) => {
		if (event.isComposing) {
			return;
		}
		if (event.key === "Enter" || event.key === ",") {
			event.preventDefault();
			add(entry.value);
		} else if (event.key === "Backspace" && !entry.value && current().length) {
			save(current().slice(0, -1));
		}
	});
}
