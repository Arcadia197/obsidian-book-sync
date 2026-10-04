// A VaultWriter in memory, for step tests and for the parity script's simulated apply. Records every write.
import type { VaultWriter } from "../src/core/changes";

export class MemoryVault implements VaultWriter {
	readonly files: Map<string, string>;
	readonly writes: string[] = [];

	constructor(files: Record<string, string> = {}) {
		this.files = new Map(Object.entries(files));
	}

	async read(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}

	async listNotes(folder: string): Promise<string[]> {
		const prefix = `${folder.replace(/\/+$/, "")}/`;
		return [...this.files.keys()]
			.filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/") && path.endsWith(".md"))
			.sort();
	}

	async process(path: string, fn: (text: string) => string): Promise<string> {
		const text = this.files.get(path);
		if (text === undefined) {
			throw new Error(`${path} not found`);
		}
		const next = fn(text);
		this.files.set(path, next);
		this.writes.push(path);
		return next;
	}

	async create(path: string, text: string): Promise<void> {
		if (this.files.has(path)) {
			throw new Error(`${path} already exists`);
		}
		this.files.set(path, text);
		this.writes.push(path);
	}
}
