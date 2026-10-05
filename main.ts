import { Platform, Plugin, WorkspaceLeaf } from "obsidian";
import { Clients, createClients, Endpoints } from "./src/api/clients";
import { ApplyResult, Change, Plan, selectedChanges, StepId } from "./src/core/changes";
import { doneTodos, mergeTodos, parseTodos, Todo, TodoChecks } from "./src/core/todos";
import { obsidianHttp } from "./src/obsidianHttp";
import { obsidianVault } from "./src/obsidianVault";
import { FULL_SYNC, PHASES } from "./src/run/stepInfo";
import { BookSyncSettings, mergeSettings, migrateSecretNames } from "./src/settings";
import { STEPS } from "./src/steps";
import { loadBacklog, PlanContext, rowGoodreadsId } from "./src/steps/context";
import { localDate, planAddBook } from "./src/steps/addBook";
import { LinkPayload, resolveLinkInput } from "./src/steps/linkIds";
import { PullPayload, refinePullLabels } from "./src/steps/pullGoodreads";
import { BookSyncView, VIEW_TYPE } from "./src/ui/BookSyncView";
import { SettingsTab } from "./src/ui/SettingsTab";

export default class BookSyncPlugin extends Plugin {
	settings!: BookSyncSettings;
	/** Where requests go when no endpoints are passed; only the e2e test sets it (fake servers) */
	endpoints?: Endpoints;
	/** "Left for you", kept in data.json next to the settings so every synced device shows the same list */
	todos: Todo[] = [];
	private statusEl: HTMLElement | null = null;
	/** When Hardcover and Goodreads were last asked whether items are done (local checks run every time) */
	private lastRemoteCheck = 0;

	async onload() {
		const saved = await this.loadData();
		this.settings = mergeSettings(saved);
		this.todos = parseTodos(saved?.todos);
		if (migrateSecretNames(saved, this.settings, (name) => this.app.secretStorage?.getSecret(name) ?? null)) {
			await this.saveSettings();
		}
		this.addSettingTab(new SettingsTab(this.app, this));

		this.registerView(VIEW_TYPE, (leaf) => new BookSyncView(leaf, this));
		this.registerHoverLinkSource(VIEW_TYPE, { display: "Book Sync", defaultMod: false });
		this.addRibbonIcon("library", "Open Book Sync", () => this.openView());
		this.addCommand({ id: "open", name: "Open", callback: () => this.openView() });
		this.addCommand({ id: "full-sync", name: "Full sync", callback: () => this.startRun(FULL_SYNC) });
		this.addCommand({ id: "add-to-want-to-read", name: "Add to Want to Read", callback: async () => (await this.openView()).focusAddBook() });
		for (const phase of PHASES) {
			this.addCommand({ id: `sync-${phase.id}`, name: `Sync ${phase.name.toLowerCase()}`, callback: () => this.startRun(phase.steps) });
		}
		// Phones have no status bar
		if (!Platform.isMobile) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.addClass("book-sync-status", "mod-clickable");
			this.statusEl.addEventListener("click", () => this.openView());
			this.app.workspace.onLayoutReady(() => this.setRestingStatus());
		}
	}

	async saveSettings() {
		await this.saveData({ ...this.settings, todos: this.todos });
	}

	/** data.json changed on disk (Obsidian Sync brought another device's edits): take its settings and list */
	async onExternalSettingsChange() {
		const saved = await this.loadData();
		this.settings = mergeSettings(saved);
		this.todos = parseTodos(saved?.todos);
		this.refreshViews();
	}

	/** Adds items to "Left for you" (one per key) and saves */
	async addTodos(items: Todo[]): Promise<void> {
		if (!items.length) {
			return;
		}
		this.todos = mergeTodos(this.todos, items, localDate());
		await this.saveSettings();
		this.refreshViews();
	}

	/** Ticks an item off by hand */
	async removeTodo(key: string): Promise<void> {
		this.todos = this.todos.filter((t) => t.key !== key);
		await this.saveSettings();
		this.refreshViews();
	}

	/**
	 * Drops the items that are done: note fields filled, Labels added (read from the vault every time), edition picked
	 * and Goodreads shelf updated (asked online at most every 10 minutes). Returns how many went. Errors keep items.
	 */
	async checkTodos(): Promise<number> {
		// Another device's changes arrive through onExternalSettingsChange; reloading here could drop items added meanwhile
		if (!this.todos.length) {
			return 0;
		}
		const vault = obsidianVault(this.app);
		let backlog: ReturnType<typeof loadBacklog> | null = null;
		const checks: TodoChecks = {
			readNote: (path) => vault.read(path),
			rowLabels: async (goodreadsId) => {
				backlog ??= loadBacklog(vault, this.settings);
				const row = (await backlog).rows.find((r) => rowGoodreadsId(r) === goodreadsId);
				return row ? row.cells["Labels"] ?? "" : null;
			},
		};
		const remote = this.todos.some((t) => t.check?.kind === "edition" || t.check?.kind === "offShelf");
		if (remote && Date.now() - this.lastRemoteCheck > 10 * 60 * 1000) {
			this.lastRemoteCheck = Date.now();
			const clients = this.clients();
			if (this.settings.hardcoverToken) checks.editions = (ids) => clients.hardcover.shelfEditions(ids);
			if (this.settings.goodreadsRssUrl) {
				checks.shelfIds = async () => {
					const shelf = await clients.goodreads.fetchShelf(this.settings.goodreadsRssUrl);
					// The feed may stop at a page of 100: then a missing book can still be on the shelf
					return shelf.length >= 100 ? null : new Set(shelf.map((e) => e.goodreadsId));
				};
			}
		}
		const done = await doneTodos(this.todos, checks);
		if (done.size) {
			this.todos = this.todos.filter((t) => !done.has(t.key));
			await this.saveSettings();
			this.refreshViews();
		}
		return done.size;
	}

	/** Redraws the Book Sync tab (it also sets the status bar), or just the status bar without one */
	private refreshViews(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE).filter((leaf) => leaf.view instanceof BookSyncView);
		leaves.forEach((leaf) => (leaf.view as BookSyncView).refresh());
		if (!leaves.length) this.setRestingStatus();
	}

	/** Fresh API clients with the current keys; `endpoints` is for the e2e test's fake servers */
	clients(endpoints = this.endpoints): Clients {
		return createClients(this.settings, obsidianHttp, endpoints);
	}

	/** What plan() gets. Reads only: the Hardcover client has no mutate() */
	planContext(endpoints = this.endpoints): PlanContext {
		const clients = this.clients(endpoints);
		return {
			vault: obsidianVault(this.app),
			settings: this.settings,
			hardcover: clients.hardcover,
			goodreads: clients.goodreads,
			openai: clients.openai,
		};
	}

	/** What a step would change. Reads only */
	async planStep(id: StepId, endpoints = this.endpoints): Promise<Plan> {
		return STEPS[id].plan(this.planContext(endpoints));
	}

	/** Writes the plan's ticked, ready changes. Only the push and labels steps use the Hardcover writer */
	async applyStep(plan: Plan, endpoints = this.endpoints): Promise<ApplyResult> {
		const ctx = { vault: obsidianVault(this.app), settings: this.settings, hardcover: this.clients(endpoints).hardcoverWriter };
		const result = await STEPS[plan.step].apply(ctx, selectedChanges(plan));
		await this.addTodos(result.todos ?? []);
		return result;
	}

	/** "Add a book": the row a Goodreads link or id would become. Reads only */
	planAddBook(idOrUrl: string): Promise<Plan> {
		return planAddBook(this.planContext(), idOrUrl);
	}

	/** The review window's "refine" box: revises every new row's Labels from plain-language feedback */
	refineLabels(plan: Plan, feedback: string): Promise<void> {
		return refinePullLabels(this.planContext(), plan as Plan<PullPayload>, feedback);
	}

	/** The review window's paste field: looks up the pasted Hardcover link; what to show next to the field */
	resolveLink(change: Change): Promise<string> {
		return resolveLinkInput(this.clients().hardcover, change as Change<LinkPayload>);
	}

	/** Shows the Book Sync tab, opening it if needed */
	async openView(): Promise<BookSyncView> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
		await leaf.loadIfDeferred();
		const view = leaf.view as BookSyncView;
		view.refresh();
		return view;
	}

	async startRun(steps: StepId[]): Promise<void> {
		(await this.openView()).startRun(steps);
	}

	/** Desktop status bar: where a running sync is */
	setStatus(text: string): void {
		this.statusEl?.setText(text);
	}

	/** Desktop status bar when no sync is running: how many items are left for you */
	setRestingStatus(): void {
		this.setStatus(this.todos.length ? `Book Sync: ${this.todos.length} left for you` : "");
	}
}
