import { test } from "node:test";
import { strict as assert } from "node:assert";
import { booksPath, DEFAULT_SETTINGS, mergeSettings, migrateSecretNames } from "../src/settings";

test("mergeSettings: no saved data gives the defaults", () => {
	assert.deepEqual(mergeSettings(null), DEFAULT_SETTINGS);
	assert.deepEqual(mergeSettings(undefined), DEFAULT_SETTINGS);
	assert.deepEqual(mergeSettings("junk"), DEFAULT_SETTINGS);
});

test("mergeSettings: saved values win, unknown keys and wrong types are dropped", () => {
	const merged = mergeSettings({ booksFolder: "Library", ownerName: 7, legacy: "x" });
	assert.equal(merged.booksFolder, "Library");
	assert.equal(merged.ownerName, DEFAULT_SETTINGS.ownerName);
	assert.equal("legacy" in merged, false);
});

test("mergeSettings: does not change the defaults object", () => {
	mergeSettings({ booksFolder: "Library" });
	assert.equal(DEFAULT_SETTINGS.booksFolder, "Books");
});

test("booksPath: joins with one slash, an empty folder means the vault root", () => {
	const at = (booksFolder: string) => ({ ...DEFAULT_SETTINGS, booksFolder });
	assert.equal(booksPath(at("03 - Misc/Books"), "Want to Read.md"), "03 - Misc/Books/Want to Read.md");
	assert.equal(booksPath(at("/Books/"), "/Database"), "Books/Database");
	assert.equal(booksPath(at(""), "Database"), "Database");
});

test("migrateSecretNames: copies keys out of the old secret storage once, keeps a key already typed in", () => {
	const settings = mergeSettings({ openaiKey: "typed-in" });
	const store: Record<string, string> = { "hc-name": "hc-value", "oa-name": "oa-value" };
	const saved = { hardcoverTokenSecret: "hc-name", openaiKeySecret: "oa-name", goodreadsRssSecret: "missing" };
	assert.equal(migrateSecretNames(saved, settings, (name) => store[name] ?? null), true);
	assert.equal(settings.hardcoverToken, "hc-value");
	assert.equal(settings.openaiKey, "typed-in");
	assert.equal(settings.goodreadsRssUrl, "");
	assert.equal("hardcoverTokenSecret" in settings, false);
});

test("migrateSecretNames: nothing to do without old secret names", () => {
	assert.equal(migrateSecretNames({ hardcoverToken: "x" }, mergeSettings({}), () => "never"), false);
	assert.equal(migrateSecretNames(null, mergeSettings({}), () => "never"), false);
});
