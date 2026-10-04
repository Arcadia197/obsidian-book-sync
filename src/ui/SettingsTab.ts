import { AbstractInputSuggest, App, Notice, PluginSettingTab, Setting, TextComponent, TFile, TFolder } from "obsidian";
import type BookSyncPlugin from "../../main";
import { DEFAULT_SETTINGS } from "../settings";
import { booksPath } from "../settings";

type TextKey = "booksFolder" | "wantToReadFile" | "hardcoverListsFile" | "databaseFolder" | "ownerName";
type KeySetting = "hardcoverToken" | "openaiKey" | "goodreadsRssUrl";

interface ModelOption {
	id: string;
	label: string;
	price?: string;
}

/** Label suggestions are short calls; prices as of October 2026 (input / output per 1M tokens) */
const MODELS: ModelOption[] = [
	{ id: "gpt-6-luna", label: "GPT-6 Luna (fast, cheap)", price: "$0.10 / $0.50" },
	{ id: "gpt-6-sol", label: "GPT-6 Sol (as the Python scripts)" },
	{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol (stronger)", price: "$2 / $10" },
	{ id: "gpt-6-astra", label: "GPT-6 Astra (most capable)", price: "$10 / $50" },
];

/** A dropdown of matching values under a text field, Obsidian's own suggest popover */
class ListSuggest extends AbstractInputSuggest<string> {
	constructor(app: App, private readonly input: HTMLInputElement, private readonly items: () => string[]) {
		super(app, input);
	}

	protected getSuggestions(query: string): string[] {
		const q = query.trim().toLowerCase();
		return this.items()
			.filter((item) => item.toLowerCase().includes(q))
			.slice(0, 50);
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	selectSuggestion(value: string): void {
		this.setValue(value);
		// The field's onChange saves it
		this.input.dispatchEvent(new Event("input"));
		this.close();
	}
}

export class SettingsTab extends PluginSettingTab {
	constructor(app: App, private plugin: BookSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Files").setHeading();
		this.text("booksFolder", "Books folder", "Folder that holds the backlog, the lists mapping and the Database folder.", () => this.folders(""));
		this.text("wantToReadFile", "Want to Read file", "Backlog table, inside the Books folder.", () => this.booksFiles());
		this.text("hardcoverListsFile", "Hardcover lists file", "Label to Hardcover list mapping, inside the Books folder.", () => this.booksFiles());
		this.text("databaseFolder", "Database folder", "One note per book, inside the Books folder.", () => this.folders(this.plugin.settings.booksFolder));

		new Setting(containerEl).setName("Sync").setHeading();
		this.text(
			"ownerName",
			"Owner name",
			'Your name as it appears in the owned field of your book notes (e.g. "Julius"), not your Hardcover username. Books with it sync with your Hardcover "owned" list.',
			() => this.ownerNames(),
		);
		this.model();

		new Setting(containerEl)
			.setName("Keys")
			.setDesc("Saved in the plugin's data.json inside the vault, so they sync to your other devices along with the vault.")
			.setHeading();
		this.key("hardcoverToken", "Hardcover API token", "From hardcover.app, Settings, API.", async () => {
			const name = await this.plugin.clients().hardcover.whoAmI();
			return `The token works: signed in as ${name}.`;
		});
		this.key("openaiKey", "OpenAI API key", "For label suggestions.", () => this.plugin.clients().openai.checkKey());
		this.key("goodreadsRssUrl", "Goodreads RSS URL", "The to-read shelf's RSS link. It contains a private key.", async () => {
			const shelf = await this.plugin.clients().goodreads.fetchShelf(this.plugin.settings.goodreadsRssUrl);
			return `The feed works: ${shelf.length} book${shelf.length === 1 ? "" : "s"} on the shelf.`;
		});
	}

	private text(key: TextKey, name: string, desc: string, suggestions?: () => string[]): void {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) => {
				text
					.setPlaceholder(DEFAULT_SETTINGS[key] || "")
					.setValue(this.plugin.settings[key])
					.onChange(async (value) => {
						this.plugin.settings[key] = value.trim();
						await this.plugin.saveSettings();
					});
				if (suggestions) new ListSuggest(this.app, text.inputEl, suggestions);
			});
	}

	/** Folder paths inside `base` (the whole vault for ""), relative to it */
	private folders(base: string): string[] {
		const prefix = base.replace(/^\/+|\/+$/g, "");
		return this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && !f.isRoot())
			.map((f) => f.path)
			.filter((path) => !prefix || path.startsWith(`${prefix}/`))
			.map((path) => (prefix ? path.slice(prefix.length + 1) : path))
			.sort();
	}

	/** Markdown files inside the Books folder, relative to it */
	private booksFiles(): string[] {
		const prefix = booksPath(this.plugin.settings, "");
		return this.app.vault
			.getMarkdownFiles()
			.map((f) => f.path)
			.filter((path) => !prefix || path.startsWith(prefix))
			.map((path) => path.slice(prefix.length))
			.sort();
	}

	/** Names found in the owned field of the Database notes, most used first */
	private ownerNames(): string[] {
		const folder = booksPath(this.plugin.settings, this.plugin.settings.databaseFolder);
		const counts = new Map<string, number>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!file.path.startsWith(`${folder}/`)) continue;
			const owned: unknown = this.app.metadataCache.getFileCache(file as TFile)?.frontmatter?.owned;
			for (const name of Array.isArray(owned) ? owned : [owned]) {
				if (typeof name === "string" && name.trim()) counts.set(name.trim(), (counts.get(name.trim()) ?? 0) + 1);
			}
		}
		return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
	}

	/** Curated models with prices, plus "Custom…" for any model id. A saved id that isn't listed shows as Custom */
	private model(): void {
		const CUSTOM = "__custom__";
		const current = this.plugin.settings.openaiModel;
		const listed = MODELS.some((m) => m.id === current);
		let custom: TextComponent;
		const save = async (value: string) => {
			this.plugin.settings.openaiModel = value;
			await this.plugin.saveSettings();
		};
		new Setting(this.containerEl)
			.setName("OpenAI model")
			.setDesc("Model for label suggestions. Prices per 1M tokens (input / output), October 2026.")
			.addDropdown((dropdown) => {
				for (const model of MODELS) dropdown.addOption(model.id, model.price ? `${model.label} · ${model.price}` : model.label);
				dropdown.addOption(CUSTOM, "Custom…");
				dropdown.setValue(listed ? current : CUSTOM);
				dropdown.onChange(async (selected) => {
					const isCustom = selected === CUSTOM;
					custom.inputEl.toggle(isCustom);
					if (isCustom) {
						// The current model stays until a new id is typed
						custom.inputEl.focus();
					} else {
						custom.setValue(selected);
						await save(selected);
					}
				});
			})
			.addText((text) => {
				custom = text;
				text.setPlaceholder("model id")
					.setValue(current)
					.onChange(async (value) => {
						if (value.trim()) await save(value.trim());
					});
				text.inputEl.toggle(!listed);
			});
	}

	/** A masked text field with a Test button */
	private key(key: KeySetting, name: string, desc: string, test: () => Promise<string>): void {
		const setting = new Setting(this.containerEl).setName(name).setDesc(desc);
		const status = setting.descEl.createDiv({ cls: "book-sync-key-status" });
		setting
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(this.plugin.settings[key]).onChange(async (value) => {
					this.plugin.settings[key] = value.trim();
					status.setText("");
					await this.plugin.saveSettings();
				});
			})
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					button.setDisabled(true);
					status.removeClass("is-ok", "is-error");
					status.setText("Testing…");
					try {
						status.setText(await test());
						status.addClass("is-ok");
					} catch (err) {
						const message = (err as Error).message;
						status.setText(message);
						status.addClass("is-error");
						new Notice(`${name}: ${message}`);
					}
					button.setDisabled(false);
				}),
			);
	}
}
