import { test } from "node:test";
import { strict as assert } from "node:assert";
import { decodeEntities, GoodreadsClient, parseBookPage, parseShelfRss, rssDate } from "../src/api/goodreads";
import { ApiError } from "../src/api/http";
import { fakeClock, fakeHttp, fixture, textResponse } from "./apiFakes";

const RSS_URL = "https://www.goodreads.com/review/list_rss/1000?key=SECRETKEY&shelf=to-read";

test("parseShelfRss: plain, CDATA and entity-encoded fields, blank isbn, whitespace collapsed", () => {
	assert.deepEqual(parseShelfRss(fixture("goodreads-shelf.xml")), [
		{ title: "The Lantern Keeper", author: "Ann Author", dateAdded: "2026-10-04", isbn: "0000000001", goodreadsId: "1000001" },
		// CDATA is taken as is: its "&" is a real ampersand
		{ title: "Rivers & Roads: A Field Guide (Wayfarer, #1)", author: "Bea Writer", dateAdded: "2026-10-03", isbn: "", goodreadsId: "1000002" },
		{ title: 'L\'âme du "monde" & été', author: "Cé Auteur", dateAdded: "2026-01-01", isbn: "000000003X", goodreadsId: "1000003" },
		{ title: "A Title Over Two Lines", author: "Dee Author", dateAdded: "", isbn: "0000000004", goodreadsId: "1000004" },
	]);
});

test("parseShelfRss: an empty shelf is fine, something that isn't RSS is an error", () => {
	assert.deepEqual(parseShelfRss('<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>'), []);
	assert.throws(() => parseShelfRss("<!DOCTYPE html><html><body>Sign in</body></html>"), /didn't return an RSS feed/);
});

test("rssDate: the date as written in the feed's own offset, never shifted to another day", () => {
	assert.equal(rssDate("Sun, 04 Oct 2026 23:39:25 -0700"), "2026-10-04");
	assert.equal(rssDate("Thu, 01 Jan 2026 00:00:01 +1400"), "2026-01-01");
	assert.equal(rssDate("Sat, 3 Oct 2026 08:00:00 +0200"), "2026-10-03");
	assert.throws(() => rssDate("2026-10-04"), /Unexpected date/);
	assert.throws(() => rssDate("Sun, 04 Foo 2026 23:39:25 -0700"), /Unexpected date/);
});

test("decodeEntities: XML, common HTML and numeric references; unknown names stay", () => {
	assert.equal(decodeEntities("&amp;&lt;&gt;&quot;&apos;&#39;&#xE9;&#233;&unknown;"), "&<>\"''éé&unknown;");
});

test("parseBookPage: title and first author from JSON-LD (entities decoded), isbn_10 from the page data", () => {
	assert.deepEqual(parseBookPage(fixture("goodreads-book.html")), {
		title: "The Salt & the Sea: Sailor's Tales",
		author: "Eve Novelist",
		isbn: "000000000X",
	});
	assert.equal(parseBookPage("<html><body>nothing</body></html>"), null);
	assert.deepEqual(parseBookPage('<script type="application/ld+json">{"@type":"Book","name":"Bare"}</script>'), { title: "Bare", author: "", isbn: "" });
});

test("fetchShelf: GET of the RSS URL from the settings", async () => {
	const fake = fakeHttp(textResponse(fixture("goodreads-shelf.xml")));
	const client = new GoodreadsClient({ http: fake.http, clock: fakeClock() });
	const entries = await client.fetchShelf(` ${RSS_URL} `);
	assert.equal(entries.length, 4);
	assert.equal(fake.requests[0].url, RSS_URL);
	assert.equal(fake.requests[0].method, "GET");
});

test("fetchShelf: to-read unless another shelf is asked for, whatever shelf the URL names", async () => {
	const fake = fakeHttp(...Array.from({ length: 3 }, () => textResponse(fixture("goodreads-shelf.xml"))));
	const client = new GoodreadsClient({ http: fake.http, clock: fakeClock() });
	const base = "https://www.goodreads.com/review/list_rss/1000?key=SECRETKEY&shelf=";
	await client.fetchShelf(base);
	await client.fetchShelf(`${base}read`);
	await client.fetchShelf(base, "currently-reading");
	assert.deepEqual(fake.requests.map((r) => r.url), [`${base}to-read`, `${base}to-read`, `${base}currently-reading`]);
});

test("fetchShelf: errors never contain the RSS URL or its key", async () => {
	const fake = fakeHttp(textResponse(`Not found: ${RSS_URL}`, 404), textResponse(`<html>${RSS_URL}</html>`));
	const client = new GoodreadsClient({ http: fake.http, clock: fakeClock() });
	for (let i = 0; i < 2; i++) {
		await assert.rejects(client.fetchShelf(RSS_URL), (err: ApiError) => {
			assert.ok(!err.message.includes("SECRETKEY"), err.message);
			return true;
		});
	}
	await assert.rejects(client.fetchShelf("  "), /No Goodreads RSS URL/);
});

test("fetchBook: browser user agent, the page parsed; book pages spaced out", async () => {
	const page = textResponse(fixture("goodreads-book.html"));
	const fake = fakeHttp(page, page);
	const clock = fakeClock();
	const client = new GoodreadsClient({ http: fake.http, clock });
	assert.equal((await client.fetchBook("2000001")).author, "Eve Novelist");
	await client.fetchBook("2000002");
	assert.equal(fake.requests[0].url, "https://www.goodreads.com/book/show/2000001");
	assert.equal(fake.requests[0].headers?.["User-Agent"], "Mozilla/5.0");
	assert.deepEqual(clock.sleeps, [2000]);
});

test("fetchBook: an empty 202 is Goodreads' bot protection, said so; a page without metadata is an error", async () => {
	const fake = fakeHttp(textResponse("", 202), textResponse("<html></html>"), textResponse("", 404));
	const client = new GoodreadsClient({ http: fake.http, clock: fakeClock() });
	await assert.rejects(client.fetchBook("1"), (err: ApiError) => err.status === 202 && /bot protection/.test(err.message));
	await assert.rejects(client.fetchBook("1"), /No book metadata/);
	await assert.rejects(client.fetchBook("1"), /HTTP 404/);
});
