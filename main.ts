import { Plugin } from "obsidian";
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
}
