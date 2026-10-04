import { Plugin } from "obsidian";
import { BookSyncSettings, mergeSettings } from "./src/settings";
import { SettingsTab } from "./src/ui/SettingsTab";

export default class BookSyncPlugin extends Plugin {
	settings!: BookSyncSettings;

	async onload() {
		this.settings = mergeSettings(await this.loadData());
		this.addSettingTab(new SettingsTab(this.app, this));
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Value of the secret a setting points to, or null if none is chosen or it is empty */
	getSecret(key: "hardcoverTokenSecret" | "openaiKeySecret" | "goodreadsRssSecret"): string | null {
		const name = this.settings[key];
		return name ? this.app.secretStorage.getSecret(name) || null : null;
	}
}
