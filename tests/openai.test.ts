import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createClients } from "../src/api/clients";
import { ApiError } from "../src/api/http";
import { buildSystemPrompt, labelVocabulary, OPENAI_CHAT_URL, OpenAiClient, restrictToVocabulary } from "../src/api/openai";
import { DEFAULT_SETTINGS } from "../src/settings";
import { fakeClock, fakeHttp, hardcover, jsonResponse, textResponse } from "./apiFakes";

const KEY = "sk-fake-key-123";

const vocabulary = labelVocabulary([
	{ title: "Book A", labels: ["Sci-Fi", "classics"] },
	{ title: "Book B", labels: null },
	{ title: "Book C", labels: [" Sci-Fi "] },
	{ title: "Book D", labels: [] },
]);

function chat(content: unknown) {
	return jsonResponse({ choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }] });
}

test("labelVocabulary: labels from notes with example titles, at most 6 each, notes without labels add nothing", () => {
	assert.deepEqual([...vocabulary], [["Sci-Fi", ["Book A", "Book C"]], ["classics", ["Book A"]]]);
	const many = labelVocabulary(Array.from({ length: 9 }, (_, i) => ({ title: `T${i}`, labels: ["x"] })));
	assert.deepEqual(many.get("x"), ["T0", "T1", "T2", "T3", "T4", "T5"]);
});

test("buildSystemPrompt: labels sorted with examples, guidance only when there is some", () => {
	const prompt = buildSystemPrompt(vocabulary);
	assert.match(prompt, /^You propose reading-tracker labels for books/);
	assert.ok(prompt.includes("- Sci-Fi: e.g. Book A, Book C\n- classics: e.g. Book A\n"), prompt);
	assert.ok(!prompt.includes("written down exactly what"));
	assert.ok(prompt.endsWith("to an array of label strings."));
	const withGuidance = buildSystemPrompt(vocabulary, "Sci-Fi means space.");
	assert.ok(withGuidance.includes("usually implies:\n\nSci-Fi means space.\n\nFor each book given"), withGuidance);
});

test("restrictToVocabulary: exact spellings only, odd shapes dropped", () => {
	assert.deepEqual(restrictToVocabulary({ a: ["Sci-Fi", "sci-fi", "Made-Up", 3], b: "Sci-Fi", c: [] }, vocabulary), { a: ["Sci-Fi"], c: [] });
	assert.deepEqual(restrictToVocabulary(["Sci-Fi"], vocabulary), {});
	assert.deepEqual(restrictToVocabulary(null, vocabulary), {});
});

test("proposeLabels: one JSON-mode chat call with the model from the settings; answer filtered", async () => {
	const fake = fakeHttp(chat({ "1": ["Sci-Fi", "Fantasy"], "2": ["classics"] }));
	const client = new OpenAiClient({ apiKey: KEY, model: "gpt-6-sol", http: fake.http });
	const result = await client.proposeLabels(
		[
			{ id: "1", title: "Star Book", author: "Ann" },
			{ id: "2", title: "Old Book", author: "Bea" },
		],
		vocabulary,
		"Guidance.",
	);
	assert.deepEqual(result, { "1": ["Sci-Fi"], "2": ["classics"] });
	const request = fake.requests[0];
	assert.equal(request.url, OPENAI_CHAT_URL);
	assert.equal(request.headers?.Authorization, `Bearer ${KEY}`);
	const body = fake.body(0);
	assert.equal(body.model, "gpt-6-sol");
	assert.deepEqual(body.response_format, { type: "json_object" });
	assert.equal(body.temperature, undefined);
	assert.equal(body.messages[0].role, "system");
	assert.ok(body.messages[0].content.includes("Guidance."));
	assert.deepEqual(JSON.parse(body.messages[1].content), [
		{ id: "1", title: "Star Book", author: "Ann" },
		{ id: "2", title: "Old Book", author: "Bea" },
	]);
});

test("refineLabels: books, the first proposal and the feedback go along; the answer is filtered too", async () => {
	const fake = fakeHttp(chat({ "1": ["classics", "nope"] }));
	const client = new OpenAiClient({ apiKey: KEY, model: "m", http: fake.http });
	const entries = [{ id: "1", title: "Star Book", author: "Ann" }];
	const result = await client.refineLabels(entries, { "1": ["Sci-Fi"] }, "it's a classic, not sci-fi", vocabulary);
	assert.deepEqual(result, { "1": ["classics"] });
	const body = fake.body(0);
	assert.ok(body.messages[0].content.endsWith("final array of label strings."));
	assert.ok(body.messages[0].content.includes("initial_proposal"));
	assert.deepEqual(JSON.parse(body.messages[1].content), {
		books: entries,
		initial_proposal: { "1": ["Sci-Fi"] },
		feedback: "it's a classic, not sci-fi",
	});
});

test("no vocabulary yet: no call; propose gives nothing, refine gives the proposal back", async () => {
	const fake = fakeHttp();
	const client = new OpenAiClient({ apiKey: KEY, model: "m", http: fake.http });
	assert.deepEqual(await client.proposeLabels([{ id: "1", title: "t", author: "a" }], new Map()), {});
	assert.deepEqual(await client.refineLabels([], { "1": ["x"] }, "f", new Map()), { "1": ["x"] });
	assert.equal(fake.requests.length, 0);
});

test("errors: OpenAI's own message, never the key; no key set fails before sending", async () => {
	const fake = fakeHttp(
		jsonResponse({ error: { message: "Incorrect API key provided: sk-fak***123.", type: "invalid_request_error" } }, 401),
		textResponse("<html>bad gateway</html>", 502),
		jsonResponse({ choices: [{ message: { content: "not json" } }] }),
		jsonResponse({ choices: [] }),
	);
	const client = new OpenAiClient({ apiKey: KEY, model: "m", http: fake.http });
	await assert.rejects(client.chatJson("s", []), (err: ApiError) => {
		assert.equal(err.status, 401);
		assert.match(err.message, /Incorrect API key provided/);
		assert.ok(!err.message.includes(KEY));
		return true;
	});
	await assert.rejects(client.chatJson("s", []), /HTTP 502 with something that isn't JSON/);
	await assert.rejects(client.chatJson("s", []), /answer isn't JSON/);
	await assert.rejects(client.chatJson("s", []), /without a message/);
	const noKey = new OpenAiClient({ apiKey: "", model: "m", http: fake.http });
	await assert.rejects(noKey.chatJson("s", []), /No OpenAI API key/);
});

test("createClients: keys and model from the settings, endpoints overridable, the reader can't write", async () => {
	const fake = fakeHttp(hardcover("slug"), textResponse("", 202), chat({}));
	const settings = { ...DEFAULT_SETTINGS, hardcoverToken: "hc", openaiKey: "oa", openaiModel: "model-x" };
	const clients = createClients(settings, fake.http, { hardcover: "http://127.0.0.1:1/graphql", goodreads: "http://127.0.0.1:2/", openai: "http://127.0.0.1:3/chat" }, fakeClock());
	assert.equal("mutate" in clients.hardcover, false);
	await clients.hardcover.booksBySlug("x");
	await assert.rejects(clients.goodreads.fetchBook("42"));
	await clients.openai.chatJson("s", {});
	assert.deepEqual(fake.requests.map((r) => r.url), ["http://127.0.0.1:1/graphql", "http://127.0.0.1:2/book/show/42", "http://127.0.0.1:3/chat"]);
	assert.equal(fake.requests[0].headers?.Authorization, "Bearer hc");
	assert.equal(fake.requests[2].headers?.Authorization, "Bearer oa");
	assert.equal(fake.body(2).model, "model-x");
});
