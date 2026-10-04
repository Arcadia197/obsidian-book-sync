import { Platform, Plugin, WorkspaceLeaf } from "obsidian";
import { Clients, createClients, Endpoints } from "./src/api/clients";
import { ApplyResult, Change, Plan, selectedChanges, StepId } from "./src/core/changes";
import { obsidianHttp } from "./src/obsidianHttp";
import { obsidianVault } from "./src/obsidianVault";
import { FULL_SYNC, PHASES } from "./src/run/stepInfo";
import { BookSyncSettings, mergeSettings, migrateSecretNames } from "./src/settings";
import { STEPS } from "./src/steps";
import type { PlanContext } from "./src/steps/context";
import { LinkPayload, resolveLinkInput } from "./src/steps/linkIds";
import { PullPayload, refinePullLabels } from "./src/steps/pullGoodreads";
import { BookSyncView, VIEW_TYPE } from "./src/ui/BookSyncView";
import { SettingsTab } from "./src/ui/SettingsTab";

export default class BookSyncPlugin extends Plugin {
	settings!: BookSyncSettings;
	/** Where requests go when no endpoints are passed; only the e2e test sets it (fake servers) */
	endpoints?: Endpoints;
	private statusEl: HTMLElement | null = null;

	async onload() {
		const saved = await this.loadData();
		this.settings = mergeSettings(saved);
		if (migrateSecretNames(saved, this.settings, (name) => this.app.secretStorage?.getSecret(name) ?? null)) {
			await this.saveSettings();
		}
		this.addSettingTab(new SettingsTab(this.app, this));

		this.registerView(VIEW_TYPE, (leaf) => new BookSyncView(leaf, this));
		this.registerHoverLinkSource(VIEW_TYPE, { display: "Book Sync", defaultMod: false });
		this.addRibbonIcon("library", "Open Book Sync", () => this.openView());
		this.addCommand({ id: "open", name: "Open", callback: () => this.openView() });
		this.addCommand({ id: "full-sync", name: "Full sync", callback: () => this.startRun(FULL_SYNC) });
		for (const phase of PHASES) {
			this.addCommand({ id: `sync-${phase.id}`, name: `Sync ${phase.name.toLowerCase()}`, callback: () => this.startRun(phase.steps) });
		}
		// Phones have no status bar
		if (!Platform.isMobile) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.addClass("book-sync-status", "mod-clickable");
			this.statusEl.addEventListener("click", () => this.openView());
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
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
		return STEPS[plan.step].apply(ctx, selectedChanges(plan));
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
}
