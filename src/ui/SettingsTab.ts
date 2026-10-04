import { App, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type BookSyncPlugin from "../../main";
import { DEFAULT_SETTINGS } from "../settings";

type TextKey = "booksFolder" | "wantToReadFile" | "hardcoverListsFile" | "databaseFolder" | "ownerName" | "openaiModel";
type SecretKey = "hardcoverTokenSecret" | "openaiKeySecret" | "goodreadsRssSecret";

export class SettingsTab extends PluginSettingTab {
	constructor(app: App, private plugin: BookSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Files").setHeading();
		this.text("booksFolder", "Books folder", "Folder that holds the backlog, the lists mapping and the Database folder.");
		this.text("wantToReadFile", "Want to Read file", "Backlog table, inside the Books folder.");
		this.text("hardcoverListsFile", "Hardcover lists file", "Label to Hardcover list mapping, inside the Books folder.");
		this.text("databaseFolder", "Database folder", "One note per book, inside the Books folder.");

		new Setting(containerEl).setName("Sync").setHeading();
		this.text("ownerName", "Owner name", "The name in a note's owned field that syncs with your Hardcover \"owned\" list.");
		this.text("openaiModel", "OpenAI model", "Model for label suggestions.");

		new Setting(containerEl)
			.setName("Secrets")
			.setDesc("Stored in Obsidian's secret storage on this device, not in the vault or the plugin's data.json.")
			.setHeading();
		this.secret("hardcoverTokenSecret", "Hardcover API token", "From hardcover.app, Settings, API.");
		this.secret("openaiKeySecret", "OpenAI API key", "For label suggestions.");
		this.secret("goodreadsRssSecret", "Goodreads RSS URL", "The to-read shelf's RSS link. It contains a private key.");
	}

	private text(key: TextKey, name: string, desc: string): void {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS[key])
					.setValue(this.plugin.settings[key])
					.onChange(async (value) => {
						this.plugin.settings[key] = value.trim();
						await this.plugin.saveSettings();
					})
			);
	}

	private secret(key: SecretKey, name: string, desc: string): void {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addComponent((el) =>
				new SecretComponent(this.app, el).setValue(this.plugin.settings[key]).onChange(async (value) => {
					this.plugin.settings[key] = value;
					await this.plugin.saveSettings();
				})
			);
	}
}
