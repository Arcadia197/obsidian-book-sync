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
	// Secret names, not values: the values live in app.secretStorage (outside the vault)
	hardcoverTokenSecret: string;
	openaiKeySecret: string;
	/** Goodreads to-read RSS URL; it embeds a private key, so it is a secret too */
	goodreadsRssSecret: string;
}

export const DEFAULT_SETTINGS: BookSyncSettings = {
	booksFolder: "Books",
	wantToReadFile: "Want to Read.md",
	hardcoverListsFile: "Hardcover Lists.md",
	databaseFolder: "Database",
	ownerName: "",
	openaiModel: "gpt-6-sol",
	hardcoverTokenSecret: "",
	openaiKeySecret: "",
	goodreadsRssSecret: "",
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

/** Vault path of a file or folder inside the Books folder */
export function booksPath(settings: BookSyncSettings, relative: string): string {
	const folder = settings.booksFolder.replace(/^\/+|\/+$/g, "");
	const rest = relative.replace(/^\/+/, "");
	return folder ? `${folder}/${rest}` : rest;
}
