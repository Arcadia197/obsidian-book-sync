// Plugin settings: defaults and how data.json is merged into them. No obsidian import, so it is unit-tested.

export interface BookSyncSettings {
	/** Folder that holds the backlog, the lists mapping and the Database folder */
	booksFolder: string;
	/** Backlog table, relative to booksFolder */
	wantToReadFile: string;
	/** Label <-> Hardcover list mapping, relative to booksFolder */
	hardcoverListsFile: string;
	/** One note per book, relative to booksFolder */
	databaseFolder: string;
	/** The name in a note's `owned` field that syncs with Hardcover's "owned" list */
	ownerName: string;
	/** Model for label suggestions */
	openaiModel: string;
	// Keys are kept in data.json, so they sync with the vault to every device (Obsidian's secret storage doesn't)
	hardcoverToken: string;
	openaiKey: string;
	/** Goodreads to-read RSS URL; it embeds a private key */
	goodreadsRssUrl: string;
}

export const DEFAULT_SETTINGS: BookSyncSettings = {
	booksFolder: "Books",
	wantToReadFile: "Want to Read.md",
	hardcoverListsFile: "Hardcover Lists.md",
	databaseFolder: "Database",
	ownerName: "",
	openaiModel: "gpt-6-sol",
	hardcoverToken: "",
	openaiKey: "",
	goodreadsRssUrl: "",
};

/** Defaults overlaid with the saved values; unknown keys and values of the wrong type are dropped */
export function mergeSettings(saved: unknown): BookSyncSettings {
	const settings: BookSyncSettings = { ...DEFAULT_SETTINGS };
	if (!saved || typeof saved !== "object") {
		return settings;
	}
	for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof BookSyncSettings)[]) {
		const value = (saved as Record<string, unknown>)[key];
		if (typeof value === typeof DEFAULT_SETTINGS[key]) {
			settings[key] = value as string;
		}
	}
	return settings;
}

type KeySetting = "hardcoverToken" | "openaiKey" | "goodreadsRssUrl";

// 0.0.1 stored secret names in data.json and the keys in Obsidian's secret storage
const LEGACY_SECRET_NAMES: Record<KeySetting, string> = {
	hardcoverToken: "hardcoverTokenSecret",
	openaiKey: "openaiKeySecret",
	goodreadsRssUrl: "goodreadsRssSecret",
};

/**
 * Copies keys from Obsidian's secret storage into the settings, once. Returns true if the saved data still had
 * secret names, so the caller saves the settings again (without them).
 */
export function migrateSecretNames(saved: unknown, settings: BookSyncSettings, getSecret: (name: string) => string | null): boolean {
	if (!saved || typeof saved !== "object") {
		return false;
	}
	let found = false;
	for (const [key, legacyKey] of Object.entries(LEGACY_SECRET_NAMES) as [KeySetting, string][]) {
		const name = (saved as Record<string, unknown>)[legacyKey];
		if (typeof name === "string" && name) {
			found = true;
			settings[key] = settings[key] || getSecret(name) || "";
		}
	}
	return found;
}

/** Vault path of a file or folder inside the Books folder */
export function booksPath(settings: BookSyncSettings, relative: string): string {
	const folder = settings.booksFolder.replace(/^\/+|\/+$/g, "");
	const rest = relative.replace(/^\/+/, "");
	return folder ? `${folder}/${rest}` : rest;
}
