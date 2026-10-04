// The Book Sync tab: a start page (full sync, one phase, add a book, left for you) and the review of a run, one step
// at a time (see run/session.ts). Works the same on desktop and phone; phones get a one-line step bar, folded
// details and bigger tap targets (styles.css).

import { ItemView, Notice, Platform, setIcon, WorkspaceLeaf } from "obsidian";
import type BookSyncPlugin from "../../main";
import type { ApplyResult, Change, Plan, StepId } from "../core/changes";
import { selectedChanges } from "../core/changes";
import { SessionEntry, SyncSession, tally } from "../run/session";
import { FULL_SYNC, PHASES, STEP_INFO } from "../run/stepInfo";
import { booksPath } from "../settings";
import { CardHost, renderCard } from "./cards";

export const VIEW_TYPE = "julius-personal-book-sync-view";

export class BookSyncView extends ItemView {
	private session: SyncSession | null = null;
	// Set by ensureDom()
	private railEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private footEl!: HTMLElement;
	/** Phone cards whose details are unfolded */
	private unfolded = new Set<string>();
	/** "Left for you" keys before the run, to show what it added */
	private todosBefore = new Set<string>();
	/** Steps whose "nothing to do" was already announced */
	private announced = new Set<SessionEntry>();
	private refineText = "";
	private refining = false;
	/** The start page's "Add a book" box */
	private add: { status: "idle" | "looking" | "found" | "adding" | "done"; value: string; plan: Plan | null; error: string; result: ApplyResult | null } = {
		status: "idle",
		value: "",
		plan: null,
		error: "",
		result: null,
	};

	constructor(leaf: WorkspaceLeaf, private readonly plugin: BookSyncPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Book Sync";
	}

	getIcon(): string {
		return "library";
	}

	async onOpen(): Promise<void> {
		this.registerDomEvent(window, "resize", () => this.fitFooter());
		this.render();
		this.checkTodos();
	}

	/** Clears "Left for you" items that are done by now, quietly, and redraws if any went */
	private checkTodos(): void {
		void this.plugin.checkTodos().then((cleared) => {
			if (cleared && !this.session) this.render();
		});
	}

	/** Draws the current state; safe before onOpen (Obsidian may open a view in a background window late) */
	refresh(): void {
		this.render();
	}

	/** The view's three parts. Built on first render, not in onOpen: a run can start before Obsidian opens the view */
	private ensureDom(): void {
		if (this.bodyEl?.parentElement === this.contentEl) {
			return;
		}
		const root = this.contentEl;
		root.empty();
		root.addClass("book-sync-view");
		this.railEl = root.createDiv({ cls: "book-sync-rail" });
		this.bodyEl = root.createDiv({ cls: "book-sync-body" });
		this.footEl = root.createDiv({ cls: "book-sync-foot" });
	}

	async onClose(): Promise<void> {
		// Closing the tab halfway ends the run: nothing after this is planned or written
		this.session?.end();
		this.session = null;
		this.plugin.setStatus("");
	}

	/** The "Add to Want to Read" command: the start page with the add field focused */
	focusAddBook(): void {
		if (this.session && !this.session.ended && !this.session.finished) {
			new Notice("A sync is running in the Book Sync tab. Finish or end it, then add the book.");
			return;
		}
		this.session = null;
		if (this.add.status === "done") {
			this.add = { status: "idle", value: "", plan: null, error: "", result: null };
		}
		this.render("add-book");
	}

	/** Starts a run of `steps`, unless one is already waiting for the user */
	startRun(steps: StepId[]): void {
		if (this.session && !this.session.ended && !this.session.finished) {
			new Notice("A sync is already running in the Book Sync tab. End it first.");
			return;
		}
		this.unfolded.clear();
		this.announced.clear();
		this.todosBefore = new Set(this.plugin.todos.map((t) => t.key));
		this.refineText = "";
		this.session = new SyncSession(steps, { plan: (id) => this.plugin.planStep(id), apply: (plan) => this.plugin.applyStep(plan) }, () =>
			this.onSessionChange(),
		);
		this.ensureDom();
		this.bodyEl.scrollTop = 0;
		void this.session.start();
	}

	private onSessionChange(): void {
		const session = this.session;
		if (!session) {
			return;
		}
		for (const entry of session.entries) {
			if (entry.status === "empty" && !this.announced.has(entry)) {
				this.announced.add(entry);
				new Notice(`${STEP_INFO[entry.id].name}: nothing to do`);
			}
		}
		this.render();
	}

	private endRun(): void {
		if (!this.session) {
			return;
		}
		const wasRunning = !this.session.finished;
		this.session.end();
		this.session = null;
		if (wasRunning) {
			new Notice("Sync ended. Steps you hadn't applied wrote nothing.");
		}
		this.render();
		this.checkTodos();
	}

	// ---- rendering -------------------------------------------------------------------------------------------

	private render(focusId?: string): void {
		this.ensureDom();
		// A re-render keeps the focus (and the cursor) on the field that had it
		const active = document.activeElement;
		let selection: [number, number] | null = null;
		if (active instanceof HTMLInputElement && this.contentEl.contains(active) && (!focusId || active.dataset.focusId === focusId)) {
			focusId = active.dataset.focusId;
			selection = [active.selectionStart ?? active.value.length, active.selectionEnd ?? active.value.length];
		}
		const scroll = this.bodyEl.scrollTop;
		this.railEl.empty();
		this.bodyEl.empty();
		this.footEl.empty();
		const session = this.session;
		if (!session || session.ended) {
			this.session = null;
			this.renderHome();
		} else if (session.finished) {
			this.renderRail(session);
			this.renderDone(session);
		} else {
			this.renderRail(session);
			this.renderStep(session, session.current!);
		}
		this.bodyEl.scrollTop = scroll;
		this.contentEl.toggleClass("is-phone", Platform.isPhone);
		this.fitFooter();
		this.updateStatus();
		if (focusId) {
			const field = this.bodyEl.querySelector<HTMLInputElement>(`[data-focus-id="${CSS.escape(focusId)}"]`);
			field?.focus();
			const [start, end] = selection ?? [field?.value.length ?? 0, field?.value.length ?? 0];
			field?.setSelectionRange(Math.min(start, field.value.length), Math.min(end, field.value.length));
		}
	}

	/**
	 * Keeps the footer's buttons clear of what Obsidian floats over the bottom of the window: the status bar on
	 * desktop, the navigation bar on phones
	 */
	private fitFooter(): void {
		// Phones: the view header floats over the top of the view
		this.railEl.style.marginTop = "";
		const header = this.containerEl.querySelector<HTMLElement>(".view-header");
		if (Platform.isMobile && header) {
			const covered = header.getBoundingClientRect().bottom - this.railEl.getBoundingClientRect().top;
			if (header.getBoundingClientRect().height > 0 && covered > 0) {
				this.railEl.style.marginTop = `${covered}px`;
			}
		}
		this.footEl.style.paddingBottom = "";
		if (!this.footEl.hasChildNodes()) {
			return;
		}
		const foot = this.footEl.getBoundingClientRect();
		let overlap = 0;
		for (const el of Array.from(document.querySelectorAll<HTMLElement>(".status-bar, .mobile-navbar"))) {
			const bar = el.getBoundingClientRect();
			const visible = bar.height > 0 && getComputedStyle(el).display !== "none";
			const overlaps = bar.left < foot.right && bar.right > foot.left && bar.top < foot.bottom && bar.bottom > foot.top;
			if (visible && overlaps) {
				overlap = Math.max(overlap, foot.bottom - bar.top);
			}
		}
		if (overlap > 0) {
			const base = parseFloat(getComputedStyle(this.footEl).paddingBottom) || 0;
			this.footEl.style.paddingBottom = `${base + overlap + 4}px`;
		}
	}

	private updateStatus(): void {
		const session = this.session;
		if (!session) {
			const left = this.plugin.todos.length;
			this.plugin.setStatus(left ? `Book Sync: ${left} left for you` : "");
			return;
		}
		if (session.finished) {
			this.plugin.setStatus("Book Sync: finished");
			return;
		}
		const entry = session.current!;
		const what = { pending: "", planning: "reading", review: "waits for you", applying: "writing", applied: "done", skipped: "skipped", empty: "", failed: "needs you" }[entry.status];
		this.plugin.setStatus(`Book Sync: ${STEP_INFO[entry.id].short} ${what} (${session.position + 1}/${session.entries.length})`);
	}

	private inner(): HTMLElement {
		return this.bodyEl.createDiv({ cls: "book-sync-inner" });
	}

	private renderHome(): void {
		const inner = this.inner();
		const head = inner.createDiv();
		head.createEl("h2", { cls: "book-sync-title", text: "Book Sync" });
		head.createEl("p", { cls: "book-sync-muted", text: "Every change is shown before it's written. Nothing goes to Hardcover unless you tick it." });

		const full = inner.createEl("button", { cls: "book-sync-full" });
		setIcon(full.createSpan({ cls: "book-sync-full-icon" }), "refresh-cw");
		const text = full.createSpan({ cls: "book-sync-full-text" });
		text.createEl("b", { text: "Full sync" });
		text.createEl("small", { text: "Backlog, labels, archive · one step at a time" });
		setIcon(full.createSpan(), "chevron-right");
		full.addEventListener("click", () => this.startRun(FULL_SYNC));

		this.renderTodos(inner);

		inner.createDiv({ cls: "book-sync-label", text: "Or one part" });
		const phases = inner.createDiv({ cls: "book-sync-phases" });
		const icons = { backlog: "book-open", labels: "tag", archive: "archive" };
		for (const phase of PHASES) {
			const row = phases.createDiv({ cls: "book-sync-phase" });
			setIcon(row.createSpan({ cls: "book-sync-phase-icon" }), icons[phase.id]);
			const words = row.createDiv({ cls: "book-sync-phase-text" });
			words.createEl("b", { text: phase.name });
			words.createEl("small", { text: phase.flow });
			const run = row.createEl("button", { text: "Run" });
			run.addEventListener("click", () => this.startRun(phase.steps));
		}

		inner.createDiv({ cls: "book-sync-label", text: "Add a book" });
		this.renderAddBook(inner.createDiv({ cls: "book-sync-add" }));
	}

	private renderTodos(parent: HTMLElement): void {
		const todos = this.plugin.todos;
		if (!todos.length) {
			return;
		}
		parent.createDiv({ cls: "book-sync-label", text: `Left for you · ${todos.length}` });
		const list = parent.createEl("ul", { cls: "book-sync-todos" });
		for (const todo of todos) {
			const item = list.createEl("li");
			item.dataset.todoKey = todo.key;
			const tick = item.createEl("input", { type: "checkbox", attr: { "aria-label": "Done" } });
			const words = item.createDiv({ cls: "book-sync-todo-text" });
			words.createSpan({ text: todo.text });
			if (todo.file) this.fileLink(words, todo.file, "Open");
			if (todo.url) words.createEl("a", { cls: "book-sync-file-link external-link", text: "Open", href: todo.url });
			if (todo.added) words.createSpan({ cls: "book-sync-todo-date", text: todo.added });
			tick.addEventListener("change", async () => {
				tick.disabled = true;
				item.addClass("is-done");
				await this.plugin.removeTodo(todo.key);
				window.setTimeout(() => this.render(), 250);
			});
		}
		parent.createEl("p", {
			cls: "book-sync-muted",
			text: "The same list on every synced device. Items tick themselves off once Book Sync sees them done.",
		});
	}

	private renderAddBook(box: HTMLElement): void {
		const add = this.add;
		const reset = () => {
			this.add = { status: "idle", value: "", plan: null, error: "", result: null };
			this.render("add-book");
		};
		if (add.status === "idle" || add.status === "looking") {
			const row = box.createDiv({ cls: "book-sync-add-row" });
			const field = row.createEl("input", {
				type: "text",
				cls: "book-sync-text",
				attr: { placeholder: "Goodreads link or id", autocomplete: "off", autocapitalize: "off", spellcheck: "false", inputmode: "url" },
			});
			field.dataset.focusId = "add-book";
			field.value = add.value;
			field.disabled = add.status === "looking";
			const button = row.createEl("button", { text: add.status === "looking" ? "Looking up…" : "Look up" });
			button.disabled = add.status === "looking";
			const lookUp = async () => {
				if (this.add.status !== "idle") return;
				if (!add.value.trim()) {
					add.error = "Paste a Goodreads link or id first.";
					this.render("add-book");
					return;
				}
				add.status = "looking";
				add.error = "";
				this.render();
				try {
					add.plan = await this.plugin.planAddBook(add.value);
					add.status = "found";
				} catch (err) {
					add.status = "idle";
					add.error = (err as Error).message;
				}
				if (this.add === add) this.render(add.status === "idle" ? "add-book" : undefined);
			};
			field.addEventListener("input", () => (add.value = field.value));
			field.addEventListener("keydown", (event) => {
				if (event.key === "Enter" && !event.isComposing) void lookUp();
			});
			button.addEventListener("click", () => void lookUp());
			box.createEl("p", {
				cls: add.error ? "book-sync-error" : "book-sync-muted",
				text: add.error || "For a book that isn't on your Goodreads shelf. Shows the row before anything is added.",
			});
			return;
		}
		const plan = add.plan!;
		if (add.status === "done") {
			const body = this.box(box, "is-ok", "check");
			body.createEl("b", { text: `Added ${plan.changes[0]?.summary.replace(/^Add /, "") ?? "the book"} to Want to Read.` });
			this.lines(body, add.result?.messages ?? []);
			const actions = body.createDiv({ cls: "book-sync-actions" });
			this.fileLink(actions, booksPath(this.plugin.settings, this.plugin.settings.wantToReadFile), "Open Want to Read");
			actions.createEl("button", { text: "Add another" }).addEventListener("click", reset);
			return;
		}
		if (!plan.changes.length) {
			const body = this.box(box, "is-warning", "alert-triangle");
			this.lines(body, plan.notes);
			body.createDiv({ cls: "book-sync-actions" }).createEl("button", { text: "Try another" }).addEventListener("click", reset);
			return;
		}
		const change = plan.changes[0];
		const host: CardHost = {
			editable: add.status === "found",
			compact: false,
			result: null,
			isOpen: () => true,
			toggleOpen: () => {},
			setSelected: (c, selected) => {
				c.selected = selected;
				this.render();
			},
			refresh: (focusId) => this.render(focusId),
			resolveLink: () => Promise.resolve(""),
			fileLink: (parent, path, text) => this.fileLink(parent, path, text),
		};
		renderCard(box, change, host);
		if (plan.notes.length) {
			this.lines(box.createDiv({ cls: "book-sync-muted" }), plan.notes);
		}
		const actions = box.createDiv({ cls: "book-sync-actions" });
		const confirm = actions.createEl("button", { cls: "mod-cta", text: add.status === "adding" ? "Adding…" : "Add to Want to Read" });
		confirm.disabled = add.status === "adding" || !change.selected;
		const cancel = actions.createEl("button", { text: "Cancel" });
		cancel.disabled = add.status === "adding";
		cancel.addEventListener("click", reset);
		confirm.addEventListener("click", async () => {
			if (this.add.status !== "found") return;
			add.status = "adding";
			this.render();
			try {
				add.result = await this.plugin.applyStep(plan);
				add.status = "done";
				const skipped = add.result.skipped[0];
				if (skipped) {
					add.status = "found";
					new Notice(`Not added: ${skipped.reason}`);
				}
			} catch (err) {
				add.status = "found";
				new Notice(`Adding failed: ${(err as Error).message}`);
			}
			if (this.add === add) this.render();
		});
	}

	private renderRail(session: SyncSession): void {
		const position = session.position;
		const state = (i: number) => {
			const entry = session.entries[i];
			if (i === position && !session.finished) {
				return entry.status === "applied" ? "is-done is-current" : "is-current";
			}
			if (i < position || session.finished) {
				return entry.status === "applied" ? "is-done" : "is-passed";
			}
			return "";
		};
		if (Platform.isPhone) {
			const top = this.railEl.createDiv({ cls: "book-sync-rail-top" });
			const entry = session.current;
			const label = top.createDiv();
			if (entry) {
				label.createEl("b", { text: PHASES.find((p) => p.id === STEP_INFO[entry.id].phase)!.name });
				label.appendText(` · ${STEP_INFO[entry.id].name}`);
				top.createSpan({ cls: "book-sync-muted", text: `${position + 1}/${session.entries.length}` });
				// No ending halfway through a write: its result and reminders would go unseen
				if (entry.status !== "applying") this.endButton(top, "End");
			} else {
				label.createEl("b", { text: "Finished" });
			}
			const bar = this.railEl.createDiv({ cls: "book-sync-bar" });
			session.entries.forEach((e, i) => {
				const prev = session.entries[i - 1];
				const seg = bar.createSpan({ cls: state(i) });
				seg.toggleClass("is-gap", !!prev && STEP_INFO[prev.id].phase !== STEP_INFO[e.id].phase);
			});
			return;
		}
		const rail = this.railEl.createDiv({ cls: "book-sync-steps" });
		for (const phase of PHASES) {
			const indexes = session.entries.map((e, i) => i).filter((i) => STEP_INFO[session.entries[i].id].phase === phase.id);
			if (!indexes.length) {
				continue;
			}
			const group = rail.createDiv({ cls: "book-sync-step-group" });
			group.createDiv({ cls: "book-sync-phase-name", text: phase.name });
			const row = group.createDiv({ cls: "book-sync-step-row" });
			indexes.forEach((i, n) => {
				if (n) row.createSpan({ cls: "book-sync-step-line" });
				const node = row.createDiv({ cls: `book-sync-step ${state(i)}` });
				const dot = node.createSpan({ cls: "book-sync-dot" });
				const s = state(i);
				if (s.includes("is-done")) setIcon(dot, "check");
				else if (s === "is-passed") dot.setText("–");
				else dot.setText(String(i + 1));
				node.createSpan({ text: STEP_INFO[session.entries[i].id].short });
			});
		}
		if (!session.finished && session.current?.status !== "applying") {
			this.endButton(rail, "End sync");
		}
	}

	private endButton(parent: HTMLElement, text: string): void {
		const button = parent.createEl("button", { cls: "book-sync-end clickable-icon", attr: { "aria-label": "End this sync" } });
		setIcon(button.createSpan(), "x");
		button.createSpan({ text });
		button.addEventListener("click", () => this.endRun());
	}

	private renderStep(session: SyncSession, entry: SessionEntry): void {
		const info = STEP_INFO[entry.id];
		const inner = this.inner();
		const head = inner.createDiv();
		const phase = PHASES.find((p) => p.id === info.phase)!;
		head.createDiv({ cls: "book-sync-eyebrow", text: `${phase.name} · step ${session.position + 1} of ${session.entries.length}` });
		head.createEl("h2", { cls: "book-sync-step-title", text: info.name });
		head.createEl("p", { cls: "book-sync-muted", text: info.desc });
		if (info.phase !== "archive") {
			this.fileLink(head, booksPath(this.plugin.settings, this.plugin.settings.wantToReadFile), "Open Want to Read");
		}

		if (entry.status === "planning" || entry.status === "pending") {
			const box = inner.createDiv({ cls: "book-sync-loading" });
			box.createSpan({ cls: "book-sync-spinner" });
			const words = box.createDiv();
			words.createEl("b", { text: `${info.loading}…` });
			words.createDiv({ cls: "book-sync-muted", text: "Reads only. Nothing is written until you press Apply." });
			this.foot("Reading only", [["Cancel", () => this.endRun(), ""]]);
			return;
		}
		if (entry.status === "failed") {
			const box = this.box(inner, "is-warning", "alert-triangle");
			box.createDiv({ text: entry.applyFailed ? `Writing stopped: ${entry.error}` : `Couldn't read what to do: ${entry.error}` });
			box.createDiv({
				cls: "book-sync-muted",
				text: entry.applyFailed
					? "Some changes may have been written. Planning again shows what's left; nothing is written twice."
					: "Check the keys and paths in the plugin settings, then plan again.",
			});
			this.foot("", [
				["Skip step", () => void session.skip(), ""],
				["Plan again", () => void session.retry(), "mod-cta"],
			]);
			// The plan stays visible (locked) for context
			if (entry.plan) this.renderChanges(inner, entry, entry.plan);
			return;
		}
		const plan = entry.plan!;
		if (entry.status === "applied" && entry.result) {
			this.renderApplied(inner, entry);
		}
		if (plan.attention?.length && entry.status === "review") {
			const box = this.box(inner, "is-warning", "alert-triangle");
			this.lines(box, plan.attention);
		}
		if (plan.notes.length) {
			const details = inner.createEl("details", { cls: "book-sync-notes" });
			details.open = !Platform.isPhone;
			const summary = details.createEl("summary");
			setIcon(summary.createSpan(), "info");
			const count = plan.notes.filter((n) => !n.startsWith("  - ")).length;
			summary.createSpan({ text: count === 1 ? "1 thing to know" : `${count} things to know` });
			this.lines(details, plan.notes);
		}
		this.renderChanges(inner, entry, plan);
		this.renderFoot(session, entry, plan);
	}

	/** Report lines: "  - " lines become a list under the line before */
	private lines(parent: HTMLElement, lines: string[]): void {
		let list: HTMLElement | null = null;
		for (const line of lines) {
			if (line.startsWith("  - ")) {
				list ??= parent.createEl("ul");
				this.linkify(list.createEl("li"), line.slice(4));
			} else {
				list = null;
				this.linkify(parent.createDiv(), line);
			}
		}
	}

	/** Text with its https links clickable (push's edition reminder) */
	private linkify(parent: HTMLElement, text: string): void {
		const parts = text.split(/(https:\/\/[^\s)]+)/);
		parts.forEach((part, i) => {
			if (i % 2) parent.createEl("a", { text: part, href: part, cls: "external-link" });
			else if (part) parent.appendText(part);
		});
	}

	private box(parent: HTMLElement, cls: string, icon: string): HTMLElement {
		const box = parent.createDiv({ cls: `book-sync-box ${cls}` });
		setIcon(box.createSpan({ cls: "book-sync-box-icon" }), icon);
		return box.createDiv({ cls: "book-sync-box-body" });
	}

	private renderApplied(parent: HTMLElement, entry: SessionEntry): void {
		const result = entry.result!;
		const plan = entry.plan!;
		const ticked = new Set(selectedChanges(plan).map((c) => c.id));
		const leftAsIs = plan.changes.filter((c) => !ticked.has(c.id)).length;
		const body = this.box(parent, "is-ok", "check");
		const parts = [`${result.applied.length} written`];
		if (result.skipped.length) parts.push(`${result.skipped.length} skipped`);
		if (leftAsIs) parts.push(`${leftAsIs} left as is`);
		body.createEl("b", { text: parts.join(" · ") });
		this.lines(body, result.messages);
	}

	private renderChanges(parent: HTMLElement, entry: SessionEntry, plan: Plan): void {
		const host = this.cardHost(entry, plan);
		const local = plan.changes.filter((c) => !c.writesHardcover);
		const remote = plan.changes.filter((c) => c.writesHardcover);
		if (entry.id === "backlog/pullGoodreads" && entry.status === "review" && local.some((c) => c.input?.kind === "labels")) {
			this.renderRefine(parent, plan);
		}
		this.group(parent, local, false, host);
		this.group(parent, remote, true, host);
	}

	private group(parent: HTMLElement, changes: Change[], hardcover: boolean, host: CardHost): void {
		if (!changes.length) {
			return;
		}
		const head = parent.createDiv({ cls: `book-sync-group ${hardcover ? "is-hardcover" : ""}` });
		setIcon(head.createSpan(), hardcover ? "cloud" : "file-text");
		head.createSpan({ text: hardcover ? "Onto Hardcover" : "Into your vault" });
		head.createSpan({ cls: "book-sync-count", text: String(changes.length) });
		const ready = changes.filter((c) => c.ready);
		if (host.editable && ready.length > 1) {
			const all = ready.every((c) => c.selected);
			const button = head.createEl("button", { cls: "book-sync-link-button", text: all ? "Untick all" : "Tick all" });
			button.addEventListener("click", () => {
				ready.forEach((c) => (c.selected = !all));
				// Dependencies follow: a push into a new list needs the list, and unticking the list unticks its pushes
				const plan = this.session?.current?.plan;
				if (plan) ready.forEach((c) => this.followDependencies(plan, c));
				this.render();
			});
		}
		const cards = parent.createDiv({ cls: "book-sync-cards" });
		changes.forEach((change) => renderCard(cards, change, host));
	}

	private renderRefine(parent: HTMLElement, plan: Plan): void {
		if (!this.plugin.settings.openaiKey) {
			return;
		}
		const row = parent.createDiv({ cls: "book-sync-refine" });
		const box = row.createEl("input", {
			type: "text",
			cls: "book-sync-text",
			attr: { placeholder: "Labels not right? e.g. the second one is more grief than mystery", autocomplete: "off" },
		});
		box.value = this.refineText;
		box.disabled = this.refining;
		box.dataset.focusId = "refine";
		const button = row.createEl("button", { text: this.refining ? "Refining…" : "Refine labels" });
		button.disabled = this.refining;
		const go = async () => {
			if (!this.refineText.trim() || this.refining) return;
			this.refining = true;
			this.render();
			const entry = this.session?.current;
			try {
				await this.plugin.refineLabels(plan, this.refineText);
				this.refineText = "";
				if (entry?.status === "review") new Notice("Labels refined. Check them before applying.");
			} catch (err) {
				new Notice(`Refining failed: ${(err as Error).message}`);
			}
			this.refining = false;
			this.render();
		};
		box.addEventListener("input", () => (this.refineText = box.value));
		box.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.isComposing) void go();
		});
		button.addEventListener("click", () => void go());
	}

	private cardHost(entry: SessionEntry, plan: Plan): CardHost {
		return {
			// Locked while the AI revises the labels: an edit or an apply now would be overwritten or miss the answer
			editable: entry.status === "review" && !this.refining,
			compact: Platform.isPhone,
			result: entry.result,
			isOpen: (id) => this.unfolded.has(id),
			toggleOpen: (id) => {
				if (!this.unfolded.delete(id)) this.unfolded.add(id);
				this.render();
			},
			setSelected: (change, selected) => {
				change.selected = selected;
				const extra = this.followDependencies(plan, change);
				if (extra) new Notice(extra);
				this.render();
			},
			refresh: (focusId) => this.render(focusId),
			resolveLink: (change) => this.plugin.resolveLink(change),
			fileLink: (parent, path, text) => this.fileLink(parent, path, text),
		};
	}

	/** Ticks what a ticked change requires, unticks what requires an unticked one; a line saying so, or null */
	private followDependencies(plan: Plan, change: Change): string | null {
		if (change.selected && change.requires) {
			const needed = plan.changes.find((c) => c.id === change.requires);
			if (needed && !needed.selected && needed.ready) {
				needed.selected = true;
				return `Also ticked: ${needed.summary}`;
			}
		}
		if (!change.selected) {
			const dependents = plan.changes.filter((c) => c.requires === change.id && c.selected);
			dependents.forEach((c) => (c.selected = false));
			if (dependents.length) {
				return `Also unticked ${dependents.length} change(s) that need it`;
			}
		}
		return null;
	}

	private renderFoot(session: SyncSession, entry: SessionEntry, plan: Plan): void {
		if (entry.status === "applying") {
			const count = selectedChanges(plan).length;
			this.foot("Writing. Keep this tab open.", [
				["Skip step", null, ""],
				[`Writing ${count}…`, null, "mod-cta"],
			]);
			return;
		}
		if (entry.status === "applied") {
			const next = session.entries[session.position + 1];
			this.foot("Step done", [[next ? `Next: ${STEP_INFO[next.id].name}` : "Finish", () => void session.next(), "mod-cta"]]);
			return;
		}
		if (this.refining) {
			this.foot("Revising the labels…", [
				["Skip step", null, ""],
				["Apply", null, "mod-cta"],
			]);
			return;
		}
		const selected = selectedChanges(plan);
		const toHardcover = selected.filter((c) => c.writesHardcover).length;
		const waiting = plan.changes.filter((c) => !c.ready).length;
		const info = [`${selected.length} of ${plan.changes.length} ticked`];
		if (toHardcover) info.push(`${toHardcover} to Hardcover`);
		if (waiting) info.push(`${waiting} waiting for input`);
		this.foot(info.join(" · "), [
			["Skip step", () => void session.skip(), ""],
			[selected.length ? `Apply ${selected.length}` : "Nothing ticked", selected.length ? () => void session.apply() : null, toHardcover ? "mod-cta is-hardcover" : "mod-cta"],
		]);
	}

	/** Footer: an info line and buttons; a null action is a disabled button */
	private foot(info: string, buttons: [string, (() => void) | null, string][]): void {
		this.footEl.createDiv({ cls: "book-sync-foot-info", text: info });
		const row = this.footEl.createDiv({ cls: "book-sync-foot-buttons" });
		for (const [text, action, cls] of buttons) {
			const button = row.createEl("button", { text, cls });
			if (action) {
				button.addEventListener("click", () => {
					// One click is one action: the button is gone or disabled by the re-render that follows
					button.disabled = true;
					action();
				});
			} else {
				button.disabled = true;
			}
		}
	}

	private renderDone(session: SyncSession): void {
		const inner = this.inner();
		const head = inner.createDiv({ cls: "book-sync-done" });
		setIcon(head.createSpan({ cls: "book-sync-done-badge" }), "check");
		head.createEl("h2", { cls: "book-sync-step-title", text: "Sync finished" });
		const rows = tally(session);
		const written = rows.reduce((n, r) => n + r.written, 0);
		const skipped = rows.reduce((n, r) => n + r.skipped, 0);
		head.createEl("p", {
			cls: "book-sync-muted",
			text: `${written} change${written === 1 ? "" : "s"} written${skipped ? `, ${skipped} skipped` : ""}. Anything you left unticked stays as it was and shows up again next time.`,
		});
		const table = inner.createEl("table", { cls: "book-sync-tally" });
		session.entries.forEach((entry, i) => {
			const row = rows[i];
			const tr = table.createEl("tr");
			const name = tr.createEl("td");
			name.createSpan({ cls: "book-sync-muted", text: `${PHASES.find((p) => p.id === STEP_INFO[entry.id].phase)!.name} · ` });
			name.appendText(STEP_INFO[entry.id].name);
			if (entry.status === "empty" && entry.plan?.notes.length) {
				const details = name.createEl("details", { cls: "book-sync-notes" });
				details.createEl("summary", { text: "What it checked" });
				this.lines(details, entry.plan.notes);
			}
			const outcome =
				row.status === "applied" ? `${row.written} written${row.skipped ? `, ${row.skipped} skipped` : ""}` : row.status === "empty" ? "nothing to do" : "skipped";
			tr.createEl("td", { text: outcome });
		});
		const added = this.plugin.todos.filter((t) => !this.todosBefore.has(t.key));
		if (added.length) {
			inner.createDiv({ cls: "book-sync-label", text: "New on your Left for you list" });
			const list = inner.createEl("ul", { cls: "book-sync-details" });
			added.forEach((t) => list.createEl("li", { text: t.text }));
			inner.createEl("p", { cls: "book-sync-muted", text: "They stay on the Book Sync start page, on every device, until they're done." });
		}
		const back = inner.createEl("button", { text: "Back to Book Sync" });
		back.addEventListener("click", () => {
			this.session = null;
			this.render();
			this.checkTodos();
		});
	}

	/** A link to a vault file: opens in a new tab (the review stays open), hover shows a preview */
	fileLink(parent: HTMLElement, path: string, text: string): void {
		const link = parent.createEl("a", { cls: "book-sync-file-link internal-link", text, href: path });
		link.dataset.href = path;
		link.addEventListener("click", (event) => {
			event.preventDefault();
			void this.app.workspace.openLinkText(path, "", "tab");
		});
		link.addEventListener("mouseover", (event) => {
			this.app.workspace.trigger("hover-link", { event, source: VIEW_TYPE, hoverParent: this, targetEl: link, linktext: path });
		});
	}
}
