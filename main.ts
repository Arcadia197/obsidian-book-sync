import { Plugin } from "obsidian";
import { Clients, createClients, Endpoints } from "./src/api/clients";
import { obsidianHttp } from "./src/obsidianHttp";
import { BookSyncSettings, mergeSettings, migrateSecretNames } from "./src/settings";
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
}
