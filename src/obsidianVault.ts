// The steps' file access on Obsidian's vault. Writes go through vault.process (atomic read-modify-write) and
// vault.create, so Obsidian's cache and any open editor stay in step.

import { App, normalizePath, TFile, TFolder } from "obsidian";
import type { VaultWriter } from "./core/changes";

export function obsidianVault(app: App): VaultWriter {
	const file = (path: string) => {
		const found = app.vault.getAbstractFileByPath(normalizePath(path));
		return found instanceof TFile ? found : null;
	};
	return {
		async read(path) {
			const found = file(path);
			return found ? app.vault.read(found) : null;
		},
		async listNotes(folder) {
			const found = app.vault.getAbstractFileByPath(normalizePath(folder));
			if (!(found instanceof TFolder)) {
				return [];
			}
			return found.children
				.filter((child): child is TFile => child instanceof TFile && child.extension === "md")
				.map((child) => child.path)
				.sort();
		},
		async process(path, fn) {
			const found = file(path);
			if (!found) {
				throw new Error(`${path} not found`);
			}
			return app.vault.process(found, fn);
		},
		async create(path, text) {
			const normalized = normalizePath(path);
			if (app.vault.getAbstractFileByPath(normalized)) {
				throw new Error(`${normalized} already exists`);
			}
			const folder = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
			if (folder && !app.vault.getAbstractFileByPath(folder)) {
				await app.vault.createFolder(folder);
			}
			await app.vault.create(normalized, text);
		},
	};
}
