import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHardcover, HARDCOVER_ENDPOINT } from "../src/api/hardcover";
import { ApiError, HttpFn } from "../src/api/http";
import { fakeClock, fakeHttp, hardcover } from "./apiFakes";

const TOKEN = "fake-token-123";

function setup(...answers: ReturnType<typeof hardcover>[]) {
	const fake = fakeHttp(...answers);
	const clock = fakeClock();
	const { reader, writer } = createHardcover({ token: TOKEN, http: fake.http, clock });
	return { ...fake, clock, reader, writer };
}

test("query: POST to the endpoint with the token, the document and the variables", async () => {
	const { reader, requests, body } = setup(hardcover("slug"));
	const books = await reader.booksBySlug("the-lantern-keeper");
	assert.deepEqual(books, [{ id: 5001, title: "The Lantern Keeper" }]);
	assert.equal(requests[0].url, HARDCOVER_ENDPOINT);
	assert.equal(requests[0].method, "POST");
	assert.equal(requests[0].headers?.Authorization, `Bearer ${TOKEN}`);
	assert.equal(requests[0].headers?.["Content-Type"], "application/json");
	assert.deepEqual(body(0).variables, { slug: "the-lantern-keeper" });
});

test("pacing: 1.1s per top-level field of the previous request, the first one goes at once", async () => {
	const { reader, clock } = setup(hardcover("slug"), hardcover("isbn-one-book"), hardcover("slug"), hardcover("slug"));
	await reader.booksBySlug("a");
	await reader.lookupIsbn("0000000001"); // by_10 + by_13: costs 2
	await reader.booksBySlug("b");
	await reader.booksBySlug("c");
	// the wait after a request is 1.1s per field it had
	assert.deepEqual(clock.sleeps, [1100, 2200, 1100]);
});

test("429: waits Retry-After seconds, else 5s, 10s, ... and retries; gives up after 5 tries", async () => {
	const a = setup(hardcover("rate-limited"), hardcover("slug"));
	assert.equal((await a.reader.booksBySlug("x")).length, 1);
	assert.ok(a.clock.sleeps.includes(3000), JSON.stringify(a.clock.sleeps));

	const b = setup(...Array(5).fill(hardcover("rate-limited-no-header")));
	await assert.rejects(b.reader.booksBySlug("x"), (err: ApiError) => err.status === 429);
	assert.equal(b.requests.length, 5);
	assert.deepEqual(b.clock.sleeps.filter((ms) => ms >= 5000), [5000, 10000, 15000, 20000]);
});

test("503 is retried like 429 (the docs call it safe to retry)", async () => {
	const { reader, requests } = setup(hardcover("unavailable"), hardcover("slug"));
	await reader.booksBySlug("x");
	assert.equal(requests.length, 2);
});

test("401: a clear message that never repeats the token", async () => {
	const { reader } = setup(hardcover("bad-token"));
	await assert.rejects(reader.booksBySlug("x"), (err: ApiError) => {
		assert.equal(err.status, 401);
		assert.match(err.message, /rejected the API token/);
		assert.ok(!err.message.includes(TOKEN));
		return true;
	});
});

test("GraphQL errors, other HTTP errors and non-JSON answers become ApiErrors", async () => {
	const { reader } = setup(hardcover("validation-error"), { status: 500, headers: {}, text: "boom" }, { status: 200, headers: {}, text: "<html>" });
	await assert.rejects(reader.myLists(), /Hardcover API error: field 'nonexistent_field' not found/);
	await assert.rejects(reader.myLists(), /HTTP 500: boom/);
	await assert.rejects(reader.myLists(), /isn't JSON/);
});

test("no token: fails before sending anything", async () => {
	const fake = fakeHttp();
	const { reader } = createHardcover({ token: "", http: fake.http, clock: fakeClock() });
	await assert.rejects(reader.myLists(), /No Hardcover API token/);
	assert.equal(fake.requests.length, 0);
});

test("timeout: stops waiting and does not retry (a write may still land)", async () => {
	const requests: unknown[] = [];
	const hanging: HttpFn = (request) => {
		requests.push(request);
		return new Promise(() => {});
	};
	const { writer } = createHardcover({ token: TOKEN, http: hanging, clock: fakeClock(), timeoutMs: 20 });
	await assert.rejects(writer.addListBook(1, 2), /did not answer within/);
	assert.equal(requests.length, 1);
});

test("read-only by construction: the reader has no mutate() and refuses mutations in query()", async () => {
	const { reader, writer, requests } = setup();
	assert.equal("mutate" in reader, false);
	assert.equal(typeof writer.mutate, "function");
	await assert.rejects(reader.query("mutation X { insert_list(object: {}) { id } }"), /read-only/);
	await assert.rejects(reader.query("  # comment\n mutation { x }"), /read-only/);
	await assert.rejects(writer.mutate("{ me { id } }"), /only sends mutations/);
	assert.equal(requests.length, 0);
});

test("lookupIsbn: one distinct book across isbn_10 and isbn_13 is a match, anything else is not", async () => {
	const { reader, body } = setup(hardcover("isbn-one-book"), hardcover("isbn-same-book-twice"), hardcover("isbn-two-books"), hardcover("isbn-none"));
	assert.deepEqual(await reader.lookupIsbn("0000000001"), { book: { id: 5001, slug: "the-lantern-keeper" }, count: 1 });
	assert.deepEqual(body(0).variables, { isbn: "0000000001" });
	assert.deepEqual(await reader.lookupIsbn("x"), { book: { id: 5001, slug: "the-lantern-keeper" }, count: 1 });
	assert.deepEqual(await reader.lookupIsbn("x"), { book: null, count: 2 });
	assert.deepEqual(await reader.lookupIsbn("x"), { book: null, count: 0 });
});

test("resolveMerges: only merged ids, mapped to the canonical id and slug; ids cleaned; nothing to ask, no request", async () => {
	const { reader, body, requests } = setup(hardcover("merges"));
	const merges = await reader.resolveMerges(["6002", "6001", " 6002 ", "", "abc", 6001]);
	assert.deepEqual([...merges], [["6002", { id: 6001, slug: "rivers-and-roads" }]]);
	assert.deepEqual(body(0).variables, { ids: [6001, 6002] });
	assert.equal((await reader.resolveMerges(["", "x"])).size, 0);
	assert.equal(requests.length, 1);
});

test("shelf queries: statuses, details, finished info, tracked books", async () => {
	const { reader, body, requests } = setup(hardcover("statuses"), hardcover("details"), hardcover("finished"), hardcover("tracked"));
	assert.deepEqual(await reader.readingStatuses(), [{ book_id: 5001, status_id: 3 }, { book_id: 6001, status_id: 2 }]);
	const details = await reader.userBookDetails(["5001"]);
	assert.equal(details[0].edition?.language?.language, "French");
	assert.equal(details[0].book.slug, "the-lantern-keeper");
	assert.deepEqual(body(1).variables, { ids: [5001] });
	assert.equal((await reader.finishedInfo([5001]))[0].review, "Loved it.");
	assert.equal((await reader.trackedBooks())[0].book.contributions[0].author.name, "Ann Author");
	assert.deepEqual(await reader.userBookDetails([]), []);
	assert.deepEqual(await reader.finishedInfo([]), []);
	assert.equal(requests.length, 4);
});

test("`me` with no user: a clear error", async () => {
	const { reader } = setup(hardcover("no-user"));
	await assert.rejects(reader.readingStatuses(), /no user for this API token/);
});

test("lists: by name ignoring case, members as string ids, slug", async () => {
	const { reader, body } = setup(hardcover("my-lists"), hardcover("my-lists"), hardcover("list-books"), hardcover("list-slug"));
	assert.deepEqual(await reader.listByName(" SCI-FI "), { id: 7001, name: "Sci-Fi", slug: "sci-fi" });
	assert.equal(await reader.listByName("Fantasy"), null);
	assert.deepEqual([...(await reader.listBookIds(7001))], ["5001", "6001"]);
	assert.deepEqual(body(2).variables, { list_id: 7001 });
	assert.equal(await reader.listSlug(7003), "new-label");
});

test("addWantToRead: status 1, date_added only when known, Hardcover's refusal comes back as error", async () => {
	const { writer, body } = setup(hardcover("insert-user-book"), hardcover("insert-user-book-refused"));
	assert.deepEqual(await writer.addWantToRead(5001, "2026-10-04"), { id: 8001, error: null });
	assert.deepEqual(body(0).variables, { object: { book_id: 5001, status_id: 1, date_added: "2026-10-04" } });
	assert.deepEqual(await writer.addWantToRead(5002, ""), { id: null, error: "Book already on shelf" });
	assert.deepEqual(body(1).variables, { object: { book_id: 5002, status_id: 1 } });
});

test("createList: public list, then its slug; a refusal throws with Hardcover's reason", async () => {
	const { writer, body } = setup(hardcover("insert-list"), hardcover("list-slug"), hardcover("insert-list-refused"));
	assert.deepEqual(await writer.createList("new-label"), { id: 7003, name: "new-label", slug: "new-label" });
	assert.deepEqual(body(0).variables, { object: { name: "new-label", privacy_setting_id: 1 } });
	assert.deepEqual(body(1).variables, { id: 7003 });
	await assert.rejects(writer.createList("Sci-Fi"), /Name has already been taken/);
});

test("addListBook sends list and book id", async () => {
	const { writer, body } = setup(hardcover("insert-list-book"));
	await writer.addListBook(7001, 5001);
	assert.deepEqual(body(0).variables, { object: { list_id: 7001, book_id: 5001 } });
});

test("reader and writer share one pacer", async () => {
	const { reader, writer, clock } = setup(hardcover("slug"), hardcover("insert-list-book"));
	await reader.booksBySlug("x");
	await writer.addListBook(1, 2);
	assert.deepEqual(clock.sleeps, [1100]);
});
