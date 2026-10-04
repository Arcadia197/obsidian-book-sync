import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
	extractHardcoverListSlug,
	extractHardcoverSlug,
	extractId,
	goodreadsIdFromUrl,
	goodreadsLink,
	hardcoverLink,
	hardcoverListLink,
	parseGoodreadsId,
	parseHardcoverSlug,
} from "../src/core/idLinks";
import { titleKey } from "../src/core/titleMatch";

test("extractId: link cell gives the id, anything else comes back trimmed", () => {
	assert.equal(extractId(" [26326](https://www.goodreads.com/book/show/26326) "), "26326");
	assert.equal(extractId(" 123 "), "123");
	assert.equal(extractId(""), "");
});

test("extractHardcoverSlug / extractHardcoverListSlug", () => {
	assert.equal(extractHardcoverSlug("[312460](https://hardcover.app/books/dune)"), "dune");
	assert.equal(extractHardcoverSlug("312460"), null);
	assert.equal(extractHardcoverListSlug("[546080](https://hardcover.app/lists/sensuality)"), "sensuality");
	assert.equal(extractHardcoverListSlug("[546080](https://hardcover.app/books/sensuality)"), null);
});

test("links: blank id or slug gives an empty cell", () => {
	assert.equal(goodreadsLink("26326"), "[26326](https://www.goodreads.com/book/show/26326)");
	assert.equal(goodreadsLink(""), "");
	assert.equal(hardcoverLink(312460, "dune"), "[312460](https://hardcover.app/books/dune)");
	assert.equal(hardcoverLink(312460, ""), "");
	assert.equal(hardcoverListLink(1, "x"), "[1](https://hardcover.app/lists/x)");
});

test("Goodreads ids from URLs, slugs and bare ids", () => {
	assert.equal(goodreadsIdFromUrl("https://www.goodreads.com/book/show/2099048"), "2099048");
	assert.equal(goodreadsIdFromUrl("https://www.goodreads.com/book/show/2099048.King_Kong"), "2099048");
	assert.equal(parseGoodreadsId(" 42 "), "42");
	assert.equal(parseGoodreadsId("not an id"), null);
});

test("parseHardcoverSlug: from a URL with query or trailing parts, or a bare slug", () => {
	assert.equal(parseHardcoverSlug("https://hardcover.app/books/dune?ref=x"), "dune");
	assert.equal(parseHardcoverSlug("https://hardcover.app/books/dune/editions"), "dune");
	assert.equal(parseHardcoverSlug(" /dune/ "), "dune");
});

test("titleKey: drops parentheses, punctuation and accents, uses the first author only", () => {
	assert.equal(titleKey("The Way of Kings (The Stormlight Archive, #1)", "Brandon Sanderson, Someone Else"), "the way of kings|brandon sanderson");
	assert.equal(titleKey("Hinter  Glas!", "Robert Merle"), titleKey("hinter glas", "robert merle"));
	assert.equal(titleKey("Café", null), "caf|");
});
