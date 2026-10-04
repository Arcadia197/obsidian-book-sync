import { test } from "node:test";
import { strict as assert } from "node:assert";
import { appendMapping, labelGuidance, parseListsMapping } from "../src/core/listsMapping";
import { serializeTable } from "../src/core/table";

const FILE = [
	"#books",
	"",
	"> [!note]- How this table works",
	"> - `Label` - leave blank to exclude a list",
	"",
	"**2026-01-01: how the reader means these labels (read before proposing any):**",
	"",
	"- **`Sensuality`** is a wide umbrella.",
	"- `classics` is about the gap between setting and writing.",
	"",
	"| Label      | hardcover_list                                   |",
	"| ---------- | ------------------------------------------------ |",
	"| owned | [10](https://hardcover.app/lists/owned)              |",
	"| Sensuality | [11](https://hardcover.app/lists/sensuality)     |",
	"|            | [12](https://hardcover.app/lists/leave-me-alone) |",
	"| broken | not-a-link |",
	"",
].join("\n");

test("parseListsMapping: labels by lowercase, blank label = list left alone, unreadable ids reported", () => {
	const mapping = parseListsMapping(FILE)!;
	assert.deepEqual([...mapping.mapped.keys()], ["owned", "sensuality"]);
	assert.deepEqual(mapping.mapped.get("sensuality"), { label: "Sensuality", listId: 11, slug: "sensuality" });
	assert.deepEqual(mapping.unreadable, ["broken"]);
	assert.equal(parseListsMapping("no table"), null);
});

test("round trip: the padded table comes back byte for byte", () => {
	assert.equal(serializeTable(parseListsMapping(FILE)!.table), FILE);
});

test("regression: appendMapping adds one row per call and leaves existing rows alone (written after each list)", () => {
	const once = appendMapping(FILE, "feminism", 20, "feminism");
	const twice = appendMapping(once, "russian", 21, "russian");
	assert.equal(twice, FILE.replace("| broken | not-a-link |\n", "| broken | not-a-link |\n| feminism | [20](https://hardcover.app/lists/feminism) |\n| russian | [21](https://hardcover.app/lists/russian) |\n"));
	assert.equal(parseListsMapping(twice)!.mapped.get("russian")!.listId, 21);
});

test("labelGuidance: the section between the bold heading and the table, word for word", () => {
	assert.equal(labelGuidance(FILE), "- **`Sensuality`** is a wide umbrella.\n- `classics` is about the gap between setting and writing.");
	assert.equal(labelGuidance("| Label | hardcover_list |"), "");
});
