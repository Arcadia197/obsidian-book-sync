import { Plugin } from "obsidian";
import { Clients, createClients, Endpoints } from "./src/api/clients";
import { ApplyResult, Plan, selectedChanges, StepId } from "./src/core/changes";
import { obsidianHttp } from "./src/obsidianHttp";
import { obsidianVault } from "./src/obsidianVault";
import { BookSyncSettings, mergeSettings, migrateSecretNames } from "./src/settings";
import { STEPS } from "./src/steps";
import { SettingsTab } from "./src/ui/SettingsTab";

export default class BookSyncPlugin extends Plugin {
	settings!: BookSyncSettings;

	async onload() {
		const saved = await this.loadData();
		this.settings = mergeSettings(saved);
		if (migrateSecretNames(saved, this.settings, (name) => this.app.secretStorage?.getSecret(name) ?? null)) {
			await this.saveSettings();
		}
		this.addSettingTab(new SettingsTab(this.app, this));
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Fresh API clients with the current keys; `endpoints` is for the e2e test's fake servers */
	clients(endpoints?: Endpoints): Clients {
		return createClients(this.settings, obsidianHttp, endpoints);
	}

	/** What a step would change. Reads only: the Hardcover client it gets has no mutate() */
	async planStep(id: StepId, endpoints?: Endpoints): Promise<Plan> {
		const clients = this.clients(endpoints);
		return STEPS[id].plan({
			vault: obsidianVault(this.app),
			settings: this.settings,
			hardcover: clients.hardcover,
			goodreads: clients.goodreads,
			openai: clients.openai,
		});
	}

	/** Writes the plan's ticked, ready changes */
	async applyStep(plan: Plan): Promise<ApplyResult> {
		return STEPS[plan.step].apply({ vault: obsidianVault(this.app), settings: this.settings }, selectedChanges(plan));
	}
}
