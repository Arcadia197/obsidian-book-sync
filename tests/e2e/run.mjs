// `npm run test:e2e`: runs the built plugin in a real Obsidian on a throwaway vault and checks what a user would check by hand.
// Runs in the background: on an invisible Xvfb screen if installed, otherwise the window flashes once and is hidden
// (E2E_VISIBLE=1 keeps it on screen). Your own Obsidian and vaults are not touched.
import { readFileSync } from "fs";
import { startFakeServer } from "./fakeServer.mjs";
import { closeObsidian, createVault, launchObsidian, PLUGIN_ID, readVaultFile, sleep, vaultFileExists } from "./lib.mjs";

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok });
	console.log(`${ok ? "✔" : "✖"} ${name}${!ok && detail ? `\n    ${detail}` : ""}`);
}

const TOKEN = "fake-hardcover-token-4f9c2e";
const SECRET_NAME = "e2e-openai-key";
const SECRET_VALUE = "fake-openai-key-7d1a";

// --- Files for the pipeline steps (made-up books)
const gr = (id) => `[${id}](https://www.goodreads.com/book/show/${id})`;
const BACKLOG_PATH = "Books/Want to Read.md";
const BACKLOG = [
	"# Want to Read", "", "> [!note]- How to edit this table by hand", "> Keep the header row.", "",
	"| Title | Author | DateAdded | Genre | Labels | Notes | isbn | goodreads_id | hardcover_id |",
	"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	`|  | Ann Author | 2026-01-01 |  |  |  |  | ${gr(1000001)} |  |`,
	`| Reading Book | Cee Writer | 2025-06-01 | Essay | Sci-Fi | gift from Lea |  | ${gr(3000001)} | [7001](https://hardcover.app/books/reading-book) |`,
	`| Has Note | Dee Writer | 2025-05-01 |  |  |  |  | ${gr(3000002)} |  |`,
	"", "Text below the table.", "",
].join("\n");
const note = (fields, labels) => ["---", ...fields, labels.length ? `labels:\n${labels.map((l) => `  - ${l}`).join("\n")}` : "labels: []",
	"rating_10:", "medium: paper", "---", "# Note", "", "---", "find all books in [[../List of books]]", "", "## My notes", "Hand-written.", ""].join("\n");
const FINISHING_PATH = "Books/Database/Eve Writer - Finishing.md";
const STEP_FILES = {
	[BACKLOG_PATH]: BACKLOG,
	"Books/Database/Dee Writer - Has Note.md": note(["author: Dee Writer", "title: Has Note", "dateRead: 2025-01-01",
		"goodreads_id: https://www.goodreads.com/book/show/3000002", "hardcover_id: 7003"], []),
	[FINISHING_PATH]: note(["author: Eve Writer", "title: Finishing", "dateRead:", "goodreads_id:", "hardcover_id: 7002"], ["Sci-Fi"]),
};
const READING_BOOK = {
	book_id: 7001, status_id: 2, rating: null, owned: true, first_started_reading_date: "2026-09-01", first_read_date: null,
	edition: { title: "Reading Book", isbn_10: null, isbn_13: "9780000007001", pages: 250, image: { url: "https://example.invalid/7001.jpg" },
		language: { language: "English" }, contributions: [{ contribution: null, author: { name: "Cee Writer" } }] },
	book: { title: "Reading Book", slug: "reading-book", pages: 250, description: "A made-up book.", release_date: "2001-01-01", literary_type_id: 1,
		image: null, contributions: [{ contribution: null, author: { name: "Cee Writer" } }], featured_book_series: null, book_series: [] },
};
// Hardcover for the steps, answered by query; any mutation is recorded and refused (step 4 never writes to Hardcover)
const hardcoverMutations = [];
function stepsHardcover({ query, variables }) {
	const data = (d) => ({ status: 200, body: { data: d } });
	const me = (userBooks) => data({ me: [{ user_books: userBooks }] });
	if (/^\s*mutation/.test(query)) {
		hardcoverMutations.push(query);
		return { status: 500, body: "no Hardcover writes expected" };
	}
	if (query.includes("GetEditionByISBN")) {
		return data(variables.isbn === "0000000001" ? { by_10: [], by_13: [{ book_id: 5001, book: { slug: "the-lantern-keeper" } }] } : { by_10: [], by_13: [] });
	}
	if (query.includes("ResolveMerges")) return data({ books: [] });
	if (query.includes("UserBookDetails")) return me([READING_BOOK]);
	if (query.includes("FinishedInfo")) {
		return me([
			{ book_id: 7002, status_id: 3, rating: 4, review: "Loved it.", first_read_date: "2026-09-20" },
			{ book_id: 7001, status_id: 2, rating: null, review: null, first_read_date: null },
		]);
	}
	if (query.includes("status_id: {_in: [2, 3]}")) return me([{ book_id: 7001, status_id: 2 }, { book_id: 7002, status_id: 3 }]);
	return { status: 500, body: "unexpected query" };
}
let hardcoverScenario = null;

// Hardcover for push and labels (step 5): shelves, lists and members change as mutations come in, so a second apply
// or a retry sees what the first one wrote. `failSlugOnce` makes the slug query after a list is created fail once:
// the list exists on Hardcover, but the run stops before recording it
const writing = { mutations: [], userBooks: [{ book_id: 8002, status_id: 2, title: "Tracked Book", author: "Bea Writer" }],
	lists: [{ id: 7101, name: "Sci-Fi", slug: "sci-fi" }], members: { 7101: [8001] }, failSlugOnce: false };
function writingHardcover({ query, variables }) {
	const data = (d) => ({ status: 200, body: { data: d } });
	const me = (d) => data({ me: [d] });
	if (/^\s*mutation/.test(query)) {
		writing.mutations.push({ query: query.match(/mutation (\w+)/)[1], object: variables.object });
		if (query.includes("insert_user_book")) {
			writing.userBooks.push({ book_id: variables.object.book_id, status_id: 1, title: "?", author: "?" });
			return data({ insert_user_book: { id: 9000 + writing.userBooks.length, error: null } });
		}
		if (query.includes("insert_list_book")) {
			(writing.members[variables.object.list_id] ??= []).push(variables.object.book_id);
			return data({ insert_list_book: { id: 9500 + writing.mutations.length } });
		}
		if (query.includes("insert_list")) {
			const list = { id: 7200 + writing.lists.length, name: variables.object.name, slug: variables.object.name.toLowerCase() };
			writing.lists.push(list);
			return data({ insert_list: { id: list.id, errors: null } });
		}
	}
	if (query.includes("GetListSlug")) {
		if (writing.failSlugOnce) {
			writing.failSlugOnce = false;
			return { status: 500, body: "connection dropped" };
		}
		return data({ lists: writing.lists.filter((l) => l.id === variables.id).map((l) => ({ slug: l.slug })) });
	}
	if (query.includes("GetListBooks")) return data({ list_books: (writing.members[variables.list_id] ?? []).map((book_id) => ({ book_id })) });
	if (query.includes("lists { id name slug }")) return me({ lists: writing.lists });
	if (query.includes("ResolveMerges")) return data({ books: [] });
	if (query.includes("FinishedInfo")) {
		return me({ user_books: writing.userBooks.filter((u) => variables.ids.includes(u.book_id))
			.map((u) => ({ book_id: u.book_id, status_id: u.status_id, rating: null, review: null, first_read_date: null })) });
	}
	if (query.includes("contributions")) {
		return me({ user_books: writing.userBooks.map((u) => ({ book_id: u.book_id, status_id: u.status_id,
			book: { title: u.title, contributions: [{ contribution: null, author: { name: u.author } }] } })) });
	}
	return { status: 500, body: "unexpected query" };
}
const WRITING_BACKLOG = [
	"# Want to Read", "",
	"| Title | Author | DateAdded | Genre | Labels | Notes | isbn | goodreads_id | hardcover_id |",
	"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	`| Pushed Book | Ada Writer | 2026-10-02 |  |  |  |  | ${gr(4000001)} | [8001](https://hardcover.app/books/pushed-book) |`,
	`| Tracked Book | Bea Writer | 2026-10-01 |  | Sci-Fi |  |  | ${gr(4000002)} | [8002](https://hardcover.app/books/tracked-book) |`,
	`| Unticked Book | Cid Writer | 2026-09-30 |  | Poetry, Sci-Fi |  |  | ${gr(4000003)} | [8003](https://hardcover.app/books/unticked-book) |`,
	"",
].join("\n");
const LISTS_PATH = "Books/Hardcover Lists.md";
const LISTS_FILE = ["# Hardcover Lists", "", "| Label | hardcover_list |", "| --- | --- |", "| Sci-Fi | [7101](https://hardcover.app/lists/sci-fi) |", "", "Text below.", ""].join("\n");

createVault({ ...STEP_FILES }, { booksFolder: "Books", legacySetting: "drop me" });

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const HARDCOVER = JSON.parse(fixture("hardcover.json"));
// Answers in order per route; "hardcover" answers are names from tests/fixtures/hardcover.json
const queue = { hardcover: [], openai: [] };
const RSS_PATH = "/review/list_rss/1000?key=E2EKEY&shelf=to-read";

let cdp;
let fake;
try {
	fake = await startFakeServer(({ method, path, body }) => {
		if (method === "POST" && path === "/graphql" && hardcoverScenario) {
			return hardcoverScenario(JSON.parse(body));
		}
		if (method === "POST" && path === "/graphql") {
			const next = HARDCOVER[queue.hardcover.shift()];
			return next ?? { status: 500, body: "no answer queued" };
		}
		if (method === "GET" && path === RSS_PATH) {
			return { status: 200, headers: { "Content-Type": "application/xml" }, body: fixture("goodreads-shelf.xml") };
		}
		if (method === "GET" && path === "/book/show/202") {
			return { status: 202, body: "" };
		}
		if (method === "GET" && path.startsWith("/book/show/")) {
			return { status: 200, headers: { "Content-Type": "text/html" }, body: fixture("goodreads-book.html") };
		}
		if (method === "GET" && path === "/models") {
			return { status: 200, body: { data: [{ id: "gpt-6-sol" }, { id: "gpt-6-luna" }] } };
		}
		if (method === "POST" && path === "/chat") {
			return queue.openai.shift() ?? { status: 500, body: "no answer queued" };
		}
		return { status: 404, body: "not found" };
	});

	cdp = await launchObsidian();
	await cdp.eval(`app.plugins.setEnable(true); await app.plugins.enablePluginAndSave(${JSON.stringify(PLUGIN_ID)});`);
	await cdp.waitFor(`app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]?.settings`);
	// Obsidian asks whether to trust a vault opened for the first time; the dialog would hold the keyboard focus
	await cdp.eval(`[...document.querySelectorAll(".mod-trust-folder button")].find((b) => b.textContent.startsWith("Trust author"))?.click();`);
	const pluginData = () => JSON.parse(readVaultFile(`.obsidian/plugins/${PLUGIN_ID}/data.json`));
	const reload = async () => {
		await cdp.eval(`await app.plugins.disablePlugin(${JSON.stringify(PLUGIN_ID)}); await app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)});`);
		await cdp.waitFor(`app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]?.settings`);
	};

	// --- Load
	const loaded = await cdp.eval(`return { booksFolder: plugin.settings.booksFolder, model: plugin.settings.openaiModel, legacy: "legacySetting" in plugin.settings };`);
	check("plugin loads with saved values over the defaults, unknown keys dropped",
		loaded.booksFolder === "Books" && loaded.model === "gpt-6-sol" && !loaded.legacy, JSON.stringify(loaded));

	// --- Settings tab: typing into a field saves it, and it survives a plugin reload
	const tab = await cdp.eval(`
		const tab = app.setting.pluginTabs.find((t) => t.id === ${JSON.stringify(PLUGIN_ID)});
		tab.display();
		const names = [...tab.containerEl.querySelectorAll(".setting-item-name")].map((el) => el.textContent);
		const input = [...tab.containerEl.querySelectorAll(".setting-item")]
			.find((el) => el.querySelector(".setting-item-name")?.textContent === "Books folder")
			.querySelector("input");
		input.value = "  03 - Misc/Books  ";
		input.dispatchEvent(new Event("input"));
		await new Promise((r) => setTimeout(r, 300));
		return { names };`);
	check("settings tab shows every setting", ["Books folder", "Want to Read file", "Hardcover lists file", "Database folder", "Owner name", "OpenAI model",
		"Hardcover API token", "OpenAI API key", "Goodreads RSS URL"].every((n) => tab.names.includes(n)), JSON.stringify(tab.names));
	check("typing in the settings tab saves the trimmed value to data.json", pluginData().booksFolder === "03 - Misc/Books", JSON.stringify(pluginData()));
	await reload();
	check("settings persist across a plugin reload",
		await cdp.eval(`return plugin.settings.booksFolder;`) === "03 - Misc/Books");

	// --- Keys: masked fields, saved in data.json (synced with the vault)
	const keyField = await cdp.eval(`
		const tab = app.setting.pluginTabs.find((t) => t.id === ${JSON.stringify(PLUGIN_ID)});
		tab.display();
		const input = [...tab.containerEl.querySelectorAll(".setting-item")]
			.find((el) => el.querySelector(".setting-item-name")?.textContent === "Hardcover API token")
			.querySelector("input");
		input.value = " ${TOKEN} ";
		input.dispatchEvent(new Event("input"));
		await new Promise((r) => setTimeout(r, 300));
		return { type: input.type };`);
	check("key fields are masked", keyField.type === "password", JSON.stringify(keyField));
	check("a typed key is saved trimmed to data.json", pluginData().hardcoverToken === TOKEN, JSON.stringify(pluginData()));
	await reload();
	check("keys persist across a plugin reload", await cdp.eval(`return plugin.settings.hardcoverToken;`) === TOKEN);

	// --- One-time move from Obsidian's secret storage (0.0.1): keys copied over, secret names dropped
	await cdp.eval(`
		app.secretStorage.setSecret(${JSON.stringify(SECRET_NAME)}, ${JSON.stringify(SECRET_VALUE)});
		await plugin.saveData({ ...plugin.settings, openaiKey: "", openaiKeySecret: ${JSON.stringify(SECRET_NAME)} });`);
	await reload();
	check("a key in the old secret storage is copied into the settings",
		await cdp.eval(`return plugin.settings.openaiKey;`) === SECRET_VALUE);
	check("data.json holds the copied key and no secret names anymore",
		pluginData().openaiKey === SECRET_VALUE && !("openaiKeySecret" in pluginData()) && pluginData().hardcoverToken === TOKEN,
		JSON.stringify(Object.keys(pluginData())));

	// --- API clients through Obsidian's requestUrl, against the local fake servers
	// 20ms pacing instead of Hardcover's 1.1s per request: the fake server has no rate limit, and the run stays short
	const endpoints = JSON.stringify({ hardcover: `${fake.url}/graphql`, goodreads: fake.url, openai: `${fake.url}/chat`, openaiModels: `${fake.url}/models`, hardcoverIntervalMs: 20 });
	const sent = () => fake.requests.length;

	queue.hardcover.push("merges");
	const merges = await cdp.eval(`return [...(await plugin.clients(${endpoints}).hardcover.resolveMerges(["6002", "6001"]))];`);
	const hcRequest = fake.requests.at(-1);
	check("a Hardcover query goes through requestUrl with the token and comes back parsed",
		JSON.stringify(merges) === JSON.stringify([["6002", { id: 6001, slug: "rivers-and-roads" }]])
			&& hcRequest.headers.authorization === `Bearer ${TOKEN}`
			&& JSON.parse(hcRequest.body).variables.ids.join() === "6001,6002",
		JSON.stringify({ merges, headers: hcRequest.headers }));

	queue.hardcover.push("rate-limited-short", "slug");
	HARDCOVER["rate-limited-short"] = { status: 429, headers: { "Retry-After": "1" }, body: { error: "Too Many Requests" } };
	const before429 = sent();
	const retried = await cdp.eval(`
		const started = Date.now();
		const books = await plugin.clients(${endpoints}).hardcover.booksBySlug("the-lantern-keeper");
		return { books, ms: Date.now() - started };`);
	check("a 429 with Retry-After is read through requestUrl, waited out and retried",
		retried.books[0]?.id === 5001 && sent() - before429 === 2 && retried.ms >= 1000, JSON.stringify(retried));

	queue.hardcover.push("bad-token");
	const rejected = await cdp.eval(`
		try { await plugin.clients(${endpoints}).hardcover.myLists(); return { ok: true }; }
		catch (err) { return { message: err.message, status: err.status }; }`);
	check("a rejected token is a clear error that doesn't repeat the token",
		rejected.status === 401 && /rejected the API token/.test(rejected.message) && !rejected.message.includes(TOKEN), JSON.stringify(rejected));

	const beforeReadOnly = sent();
	const readOnly = await cdp.eval(`
		const { hardcover } = plugin.clients(${endpoints});
		let refused = false;
		try { await hardcover.query("mutation { insert_list(object: {name: \\"x\\"}) { id } }"); } catch { refused = true; }
		return { hasMutate: "mutate" in hardcover, refused };`);
	check("the read-only Hardcover client has no mutate() and sends nothing for a mutation",
		!readOnly.hasMutate && readOnly.refused && sent() === beforeReadOnly, JSON.stringify(readOnly));

	queue.hardcover.push("insert-list-book");
	await cdp.eval(`await plugin.clients(${endpoints}).hardcoverWriter.addListBook(7001, 5001);`);
	const mutation = JSON.parse(fake.requests.at(-1).body);
	check("the writer sends the mutation with its variables",
		/^mutation InsertListBook/.test(mutation.query) && mutation.variables.object.list_id === 7001, JSON.stringify(mutation));

	const shelf = await cdp.eval(`
		plugin.settings.goodreadsRssUrl = ${JSON.stringify(fake.url + RSS_PATH)};
		return await plugin.clients(${endpoints}).goodreads.fetchShelf(plugin.settings.goodreadsRssUrl);`);
	check("the Goodreads RSS shelf is fetched and parsed",
		shelf.length === 4 && shelf[2].title === `L'âme du "monde" & été` && shelf[0].dateAdded === "2026-10-04", JSON.stringify(shelf));

	const pages = await cdp.eval(`
		const { goodreads } = plugin.clients(${endpoints});
		const book = await goodreads.fetchBook("2000001");
		let busy = null;
		try { await goodreads.fetchBook("202"); } catch (err) { busy = { status: err.status, message: err.message }; }
		return { book, busy };`);
	const pageRequest = fake.requests.find((r) => r.path === "/book/show/2000001");
	check("a Goodreads book page is parsed, and an empty 202 is reported as bot protection",
		pages.book.title === "The Salt & the Sea: Sailor's Tales" && pages.busy?.status === 202 && /bot protection/.test(pages.busy.message)
			&& pageRequest?.headers["user-agent"] === "Mozilla/5.0",
		JSON.stringify({ pages, ua: pageRequest?.headers["user-agent"] }));

	queue.openai.push({ status: 200, body: { choices: [{ message: { content: JSON.stringify({ "1": ["Sci-Fi", "Invented"] }) } }] } });
	const labels = await cdp.eval(`
		const vocabulary = new Map([["Sci-Fi", ["Book A"]], ["classics", ["Book B"]]]);
		return await plugin.clients(${endpoints}).openai.proposeLabels([{ id: "1", title: "Star Book", author: "Ann" }], vocabulary);`);
	const chatRequest = JSON.parse(fake.requests.at(-1).body);
	check("OpenAI label suggestions use the key and model from the settings and drop labels outside the vocabulary",
		JSON.stringify(labels) === JSON.stringify({ "1": ["Sci-Fi"] }) && fake.requests.at(-1).headers.authorization === `Bearer ${SECRET_VALUE}`
			&& chatRequest.model === "gpt-6-sol",
		JSON.stringify({ labels, model: chatRequest.model }));

	// --- Pipeline steps: plan() reads only, apply() writes only ticked changes, in the test vault
	hardcoverScenario = stepsHardcover;
	await cdp.eval(`plugin.settings.booksFolder = "Books"; plugin.settings.goodreadsRssUrl = ${JSON.stringify(fake.url + RSS_PATH)};`);
	const planStep = (id) => cdp.eval(`window.__plan = await plugin.planStep(${JSON.stringify(id)}, ${endpoints}); return window.__plan;`);
	const applyStep = (select = "") => cdp.eval(`${select}; return await plugin.applyStep(window.__plan, ${endpoints});`);
	const backlog = () => readVaultFile(BACKLOG_PATH);
	const rowOf = (id) => backlog().split("\n").find((line) => line.includes(`[${id}](`));

	queue.openai.push({ status: 200, body: { choices: [{ message: { content: JSON.stringify({ "1000002": ["Sci-Fi"], "1000003": ["Made Up"], "1000004": [] }) } }] } });
	let plan = await planStep("backlog/pullGoodreads");
	const chat = JSON.parse(fake.requests.at(-1).body);
	check("pull: plan lists new rows and updates, with label suggestions from the notes' vocabulary, and writes nothing",
		JSON.stringify(plan.changes.map((c) => c.id)) === JSON.stringify(["update:1000001", "add:1000002", "add:1000003", "add:1000004"])
			&& plan.changes.find((c) => c.id === "add:1000002").input.value === "Sci-Fi"
			&& chat.messages[0].content.includes("- Sci-Fi: e.g. Finishing") && backlog() === BACKLOG,
		JSON.stringify({ ids: plan.changes.map((c) => c.id), labels: plan.changes.map((c) => c.input?.value) }));

	const nothing = await applyStep("window.__plan.changes.forEach((c) => (c.selected = false))");
	check("pull: applying with nothing ticked writes nothing", backlog() === BACKLOG && nothing.applied.length === 0, JSON.stringify(nothing));

	const pulled = await applyStep(`window.__plan.changes.forEach((c) => (c.selected = c.id !== "add:1000003"))`);
	const order = backlog().split("\n").filter((l) => /^\| (?!Title|---)/.test(l)).map((l) => l.split("|")[1].trim());
	check("pull: ticked rows written, the unticked one not, hand columns kept, newest first, callout and text intact",
		rowOf(1000001)?.startsWith("| The Lantern Keeper | Ann Author | 2026-10-04 |") && rowOf(1000001).includes("| 0000000001 |")
			&& /\| Sci-Fi \|/.test(rowOf(1000002)) && !rowOf(1000003) && rowOf(3000001).includes("gift from Lea")
			&& JSON.stringify(order) === JSON.stringify(["The Lantern Keeper", "Rivers & Roads: A Field Guide (Wayfarer, #1)", "Reading Book", "Has Note", "A Title Over Two Lines"])
			&& backlog().includes("> [!note]- How to edit this table by hand") && backlog().endsWith("Text below the table.\n"),
		JSON.stringify({ order, pulled }) + "\n" + backlog());

	const afterFirst = backlog();
	const again = await applyStep();
	check("pull: applying the same plan twice (double click) adds no duplicate rows",
		backlog() === afterFirst && again.skipped.filter((s) => s.reason === "already in the table").length === 2, JSON.stringify(again));

	plan = await planStep("backlog/linkIds");
	const linked = await applyStep();
	check("link: a unique isbn match is written, a row without a match waits for a paste and stays blank",
		rowOf(1000001).endsWith("| [5001](https://hardcover.app/books/the-lantern-keeper) |") && rowOf(1000004).endsWith("|  |")
			&& plan.changes.find((c) => c.id === "link:1000004")?.ready === false && linked.applied.join() === "link:1000001",
		JSON.stringify({ changes: plan.changes.map((c) => [c.id, c.ready]), linked }));

	plan = await planStep("archive/promote");
	const promoted = await applyStep();
	const newNote = "Books/Database/Cee Writer - Reading Book.md";
	const noteText = vaultFileExists(newNote) ? readVaultFile(newNote) : "";
	check("promote: the started book gets its note (row's ids, genre and labels carried over) and its row is removed",
		plan.changes.some((c) => c.id === "promote:7001" && c.warnings.some((w) => w.includes("gift from Lea")))
			&& noteText.includes("goodreads_id: https://www.goodreads.com/book/show/3000001\nhardcover_id: 7001\n")
			&& noteText.includes("genre:\n  - Essay\nlabels:\n  - Sci-Fi\n") && !rowOf(3000001) && promoted.applied.join() === "promote:7001",
		JSON.stringify({ ids: plan.changes.map((c) => c.id), promoted }) + "\n" + noteText);

	plan = await planStep("archive/reconcile");
	await applyStep();
	check("reconcile: a row whose book already has a note is removed", plan.changes.map((c) => c.id).join() === "remove:3000002" && !rowOf(3000002),
		JSON.stringify(plan.changes.map((c) => c.id)));

	plan = await planStep("archive/finished");
	await applyStep();
	await applyStep();
	const finishedNote = readVaultFile(FINISHING_PATH);
	check("finished: dateRead, rating and review written once, the hand-written section kept after it",
		finishedNote.includes("dateRead: 2026-09-20\n") && finishedNote.includes("rating_10: 8\n")
			&& finishedNote.split("## Hardcover review").length === 2
			&& finishedNote.includes("find all books in [[../List of books]]\n\n## Hardcover review\nLoved it.\n\n## My notes"),
		finishedNote);
	check("no step sent a mutation to Hardcover", hardcoverMutations.length === 0, hardcoverMutations.join("\n"));

	// --- Hardcover-writing steps: push and labels, against the stateful fake
	hardcoverScenario = writingHardcover;
	await cdp.eval(`await app.vault.adapter.write(${JSON.stringify(BACKLOG_PATH)}, ${JSON.stringify(WRITING_BACKLOG)});
		await app.vault.adapter.write(${JSON.stringify(LISTS_PATH)}, ${JSON.stringify(LISTS_FILE)});`);
	const tick = (ids) => `window.__plan.changes.forEach((c) => (c.selected = ${JSON.stringify(ids)}.includes(c.id)))`;
	const mutations = () => writing.mutations.map((m) => `${m.query} ${JSON.stringify(m.object)}`);

	plan = await planStep("backlog/push");
	const untouched = await applyStep();
	check("push: plan offers the books with no Hardcover status, all unticked; applying it as is sends no mutation",
		plan.changes.map((c) => `${c.id}:${c.selected}`).join() === "push:8001:false,push:8003:false" && writing.mutations.length === 0
			&& untouched.applied.length === 0,
		JSON.stringify({ changes: plan.changes.map((c) => [c.id, c.selected]), mutations: mutations() }));

	const pushedResult = await applyStep(tick(["push:8001"]));
	await applyStep();
	check("push: the ticked book is added once with its date (also on a second apply), the unticked one never; edition link shown",
		JSON.stringify(mutations()) === JSON.stringify([`InsertUserBook {"book_id":8001,"status_id":1,"date_added":"2026-10-02"}`])
			&& pushedResult.messages.some((m) => m.includes("https://hardcover.app/books/pushed-book")),
		JSON.stringify({ mutations: mutations(), pushedResult }));

	plan = await planStep("labels/sync");
	const labelIds = plan.changes.map((c) => c.id).join();
	writing.failSlugOnce = true;
	const interrupted = await applyStep(tick(["list:poetry", "push:poetry:8003", "push:sci-fi:8002", "pull:row:4000001:sci-fi"]));
	const listsAfterFailure = readVaultFile(LISTS_PATH);
	check("labels: plan pulls, pushes and a new list; a run cut off after creating the list records nothing for it and writes nothing more",
		labelIds === "list:poetry,pull:row:4000001:sci-fi,push:sci-fi:8002,push:poetry:8003,push:sci-fi:8003,push:sci-fi:7001,push:sci-fi:7002"
			&& JSON.stringify(mutations().slice(1)) === JSON.stringify(['InsertList {"name":"Poetry","privacy_setting_id":1}'])
			&& interrupted.skipped.length === 3 && listsAfterFailure === LISTS_FILE
			&& rowOf(4000001).includes("|  | Sci-Fi |  |"),
		JSON.stringify({ labelIds, mutations: mutations(), interrupted }) + "\n" + listsAfterFailure);

	plan = await planStep("labels/sync");
	const link = plan.changes.find((c) => c.id === "list:poetry");
	const relinked = await applyStep(tick(["list:poetry", "push:poetry:8003", "push:sci-fi:8002"]));
	await applyStep();
	check("labels: the retry links the list made before instead of creating it again; exactly the ticked books are pushed, once",
		/Link your existing Hardcover list "Poetry" \(7201\)/.test(link?.summary ?? "")
			&& JSON.stringify(mutations().slice(1)) === JSON.stringify([
				'InsertList {"name":"Poetry","privacy_setting_id":1}',
				'InsertListBook {"list_id":7101,"book_id":8002}',
				'InsertListBook {"list_id":7201,"book_id":8003}',
			])
			&& writing.lists.filter((l) => l.name === "Poetry").length === 1
			&& readVaultFile(LISTS_PATH).includes("| Sci-Fi | [7101](https://hardcover.app/lists/sci-fi) |\n| Poetry | [7201](https://hardcover.app/lists/poetry) |\n\nText below.")
			&& relinked.applied.join() === "list:poetry,push:sci-fi:8002,push:poetry:8003",
		JSON.stringify({ link: link?.summary, mutations: mutations(), relinked }) + "\n" + readVaultFile(LISTS_PATH));

	// --- Review window (step 6): driven through its DOM, the way a user would
	const UI = `const view = app.workspace.getLeavesOfType("julius-personal-book-sync-view")[0]?.view;
		const root = view?.contentEl;
		const button = (text) => [...(root?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim().startsWith(text));
		const card = (id) => root?.querySelector(\`[data-change-id="\${id}"]\`);
		const pause = (ms) => new Promise((r) => setTimeout(r, ms));`;
	const ui = (body) => cdp.eval(`${UI} ${body}`);
	// On a timeout, the error says what the view showed instead
	const waitUi = (expr, timeout) => cdp.waitFor(`(() => { ${UI} return ${expr}; })()`, timeout).catch(async (err) => {
		const shown = await ui(`const leaf = app.workspace.getLeavesOfType("julius-personal-book-sync-view")[0];
			return leaf ? "[view " + leaf.view?.getViewType?.() + ", " + (root?.innerHTML.length ?? 0) + " chars] " + (root?.textContent.slice(0, 1500) ?? "") : "(no Book Sync view)";`).catch(() => "?");
		throw new Error(`${err.message.split("\n")[0]}\n    Waiting for: ${expr}\n    The view showed:\n${shown}`);
	});
	// A double click: two clicks in the same moment (CDP mouse input doesn't reach the hidden window). The session's own
	// guard against a second apply is unit-tested (tests/session.test.ts)
	const doubleClick = (text) => ui(`const b = button(${JSON.stringify(text)});
		b.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
		b.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));`);
	const uiHold = { promise: null, release: null };
	const holdHardcover = () => (uiHold.promise = new Promise((resolve) => (uiHold.release = resolve)));
	function uiHardcover(request) {
		if (request.query.includes("GetBookBySlug") && request.variables.slug === "slow-wrong-book") {
			// Answers after the user has pasted something else: must not land on the change
			return sleep(2500).then(() => ({ status: 200, body: { data: { books: [{ id: 9999, title: "Slow Wrong Book" }] } } }));
		}
		if (request.query.includes("GetBookBySlug")) {
			return { status: 200, body: { data: { books: request.variables.slug === "the-fourth" ? [{ id: 5004, title: "The Fourth Book" }] : [] } } };
		}
		return stepsHardcover(request);
	}
	hardcoverScenario = (request) => (uiHold.promise ? uiHold.promise.then(() => uiHardcover(request)) : uiHardcover(request));
	hardcoverMutations.length = 0;
	await cdp.eval(`await app.vault.adapter.write(${JSON.stringify(BACKLOG_PATH)}, ${JSON.stringify(BACKLOG)});
		plugin.endpoints = ${endpoints};
		window.__plans = 0; window.__applies = 0;
		const planStep = plugin.planStep.bind(plugin), applyStep = plugin.applyStep.bind(plugin);
		plugin.planStep = (...args) => { window.__plans++; return planStep(...args); };
		plugin.applyStep = (...args) => { window.__applies++; return applyStep(...args); };`);
	queue.openai.push({ status: 200, body: { choices: [{ message: { content: JSON.stringify({ "1000002": ["Sci-Fi"], "1000003": [], "1000004": [] }) } }] } });
	await cdp.eval(`app.commands.executeCommandById("${PLUGIN_ID}:sync-backlog");`);
	await waitUi(`root?.querySelectorAll(".book-sync-card").length === 4`);
	const review = await ui(`return {
		cards: [...root.querySelectorAll(".book-sync-card")].map((c) => c.dataset.changeId + ":" + c.querySelector(".book-sync-tick").checked),
		chips: [...card("add:1000002").querySelectorAll(".book-sync-chip")].map((c) => c.textContent),
		steps: root.querySelectorAll(".book-sync-step").length,
		status: document.querySelector(".book-sync-status")?.textContent };`);
	check("view: Sync backlog opens the tab on the pull plan (3 steps), local changes ticked, label chips, nothing written yet",
		review.cards.join() === "update:1000001:true,add:1000002:true,add:1000003:true,add:1000004:true" && review.chips.join() === "Sci-Fi"
			&& review.steps === 3 && /Pull waits for you \(1\/3\)/.test(review.status) && backlog() === BACKLOG,
		JSON.stringify(review));

	const none = await ui(`button("Untick all").click(); await pause(50);
		const apply = button("Nothing ticked"); apply?.click(); await pause(300);
		return { disabled: apply?.disabled, ticked: root.querySelectorAll(".book-sync-card.is-selected").length, applies: window.__applies };`);
	check("view: with nothing ticked, Apply is disabled and pressing it writes nothing",
		none.disabled === true && none.ticked === 0 && none.applies === 0 && backlog() === BACKLOG, JSON.stringify(none));

	await ui(`card("add:1000004").querySelector(".book-sync-summary").click(); await pause(50);`);
	await doubleClick("Apply 1");
	await waitUi(`button("Next:")`);
	const one = await ui(`return { applies: window.__applies, result: card("add:1000004").querySelector(".book-sync-result")?.textContent,
		other: card("add:1000002").querySelector(".book-sync-result")?.textContent };`);
	check("view: tapping a card ticks it; a double click on Apply writes that one row once, the rest stays as it was",
		one.applies === 1 && one.result === "Written" && one.other === "Not ticked, left as is"
			&& backlog().split("\n").filter((l) => l.includes("[1000004](")).length === 1 && !rowOf(1000002) && !rowOf(1000003)
			&& rowOf(1000001).startsWith("|  | Ann Author |"),
		JSON.stringify(one) + "\n" + backlog());

	await ui(`button("Next:").click();`);
	await waitUi(`card("link:1000004")?.querySelector("[data-focus-id]")`);
	const waiting = await ui(`return { ticked: card("link:1000004").querySelector(".book-sync-tick").checked, apply: button("Nothing ticked")?.disabled };`);
	// First a link whose lookup answers late, then the right one: the late answer must not replace it
	await ui(`const field = card("link:1000004").querySelector("[data-focus-id]");
		field.value = "https://hardcover.app/books/slow-wrong-book"; field.dispatchEvent(new Event("input")); await pause(1200);
		field.value = "https://hardcover.app/books/the-fourth"; field.dispatchEvent(new Event("input"));`);
	await waitUi(`card("link:1000004")?.classList.contains("is-selected")`);
	await sleep(2500);
	const pasted = await ui(`return card("link:1000004").querySelector(".book-sync-lookup").textContent;`);
	await ui(`button("Apply 1").click();`);
	await waitUi(`button("Next:")`);
	check("view: a pasted Hardcover link is looked up, ticks its card, and Apply writes its id (a late answer for an earlier paste is dropped)",
		waiting.ticked === false && waiting.apply === true && /The Fourth Book/.test(pasted)
			&& rowOf(1000004).endsWith("| [5004](https://hardcover.app/books/the-fourth) |"),
		JSON.stringify({ waiting, pasted }) + "\n" + rowOf(1000004));

	const beforeClose = backlog();
	holdHardcover();
	await ui(`button("Next:").click();`);
	await waitUi(`root?.querySelector(".book-sync-loading")`);
	await ui(`view.leaf.detach();`);
	uiHold.release();
	uiHold.promise = null;
	await sleep(1500);
	const closed = await cdp.eval(`return { leaves: app.workspace.getLeavesOfType("julius-personal-book-sync-view").length, plans: window.__plans,
		applies: window.__applies, status: document.querySelector(".book-sync-status")?.textContent };`);
	check("view: closing the tab while a step plans ends the run: nothing more planned or written",
		closed.leaves === 0 && closed.plans === 3 && closed.applies === 2 && closed.status === "" && backlog() === beforeClose
			&& hardcoverMutations.length === 0,
		JSON.stringify(closed));

	await cdp.eval(`app.commands.executeCommandById("${PLUGIN_ID}:open");`);
	await waitUi(`root?.querySelector(".book-sync-full")`);
	check("view: opened again, it shows the start page, not the ended run",
		await ui(`return !root.querySelector(".book-sync-card") && root.querySelectorAll(".book-sync-phase").length === 3;`));

	// "Add to Want to Read": the command focuses the field; the looked-up row shows as a card before it's added
	queue.openai.push({ status: 200, body: { choices: [{ message: { content: JSON.stringify({ "2000001": ["Sci-Fi"] }) } }] } });
	await cdp.eval(`app.commands.executeCommandById("${PLUGIN_ID}:add-to-want-to-read");`);
	await waitUi(`root?.querySelector('[data-focus-id="add-book"]')`);
	const focused = await ui(`await pause(100); const a = document.activeElement;
		return a === root.querySelector('[data-focus-id="add-book"]') || a.tagName + "." + a.className + " in: " + a.closest(".modal, .modal-container, .workspace-leaf, .prompt")?.className + " text: " + a.closest(".modal, .modal-container, .prompt")?.textContent.slice(0, 200);`);
	await ui(`const field = root.querySelector('[data-focus-id="add-book"]');
		field.value = "https://www.goodreads.com/book/show/2000001-the-salt"; field.dispatchEvent(new Event("input")); button("Look up").click();`);
	await waitUi(`card("add:2000001")`);
	const looked = await ui(`return { chips: [...card("add:2000001").querySelectorAll(".book-sync-chip")].map((c) => c.textContent),
		summary: card("add:2000001").querySelector(".book-sync-summary").textContent };`);
	const beforeAdd = backlog();
	await ui(`button("Add to Want to Read").click();`);
	await waitUi(`button("Add another")`);
	const today = await cdp.eval(`const d = new Date(); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");`);
	check("view: Add to Want to Read focuses the field, shows the book with suggested labels, and adds it with today's date",
		focused === true && looked.chips.join() === "Sci-Fi" && /The Salt & the Sea/.test(looked.summary) && beforeAdd === backlog().replace(rowOf(2000001) + "\n", "")
			&& rowOf(2000001)?.startsWith(`| The Salt & the Sea: Sailor's Tales |`) && rowOf(2000001).includes(`| ${today} |  | Sci-Fi |`),
		JSON.stringify({ focused, looked, row: rowOf(2000001) }));

	await ui(`button("Add another").click(); await pause(50); const field = root.querySelector('[data-focus-id="add-book"]');
		field.value = "2000001"; field.dispatchEvent(new Event("input")); button("Look up").click();`);
	await waitUi(`button("Try another")`);
	const dupe = await ui(`return root.querySelector(".book-sync-add").textContent;`);
	check("view: a book already in Want to Read is refused before anything is written",
		/Already in Want to Read: The Salt & the Sea/.test(dupe) && backlog().split("[2000001](").length === 2, dupe);

	// --- Left for you: what the applies above left to do by hand, kept in data.json for every synced device
	const todoKeys = () => (pluginData().todos ?? []).map((t) => t.key);
	const kept = pluginData().todos?.find((t) => t.key === "labels:1000004");
	// promote and reconcile also left "update Goodreads" items; the view's check on opening found those books off the
	// (fake) to-read shelf, so they are gone again
	check("left for you: applies put their hand work into data.json (blank Labels, edition to pick, note fields); Goodreads items cleared once off the shelf",
		kept?.added === today && kept.check?.kind === "rowLabels" && todoKeys().includes("edition:8001")
			&& todoKeys().some((k) => k.startsWith("fields:")) && !todoKeys().some((k) => k.startsWith("shelf:")),
		JSON.stringify(pluginData().todos));
	await reload();
	await cdp.eval(`plugin.endpoints = ${endpoints};`);
	check("left for you: the list survives a plugin reload", await cdp.eval(`return plugin.todos.length;`) === pluginData().todos.length);

	await cdp.eval(`app.commands.executeCommandById("${PLUGIN_ID}:open");`);
	await waitUi(`root?.querySelector('[data-todo-key="labels:1000004"]')`);
	const shown = await ui(`return { items: root.querySelectorAll(".book-sync-todos li").length, status: document.querySelector(".book-sync-status")?.textContent };`);
	await ui(`root.querySelector('[data-todo-key="labels:1000004"] input').click();`);
	await waitUi(`!root?.querySelector('[data-todo-key="labels:1000004"]')`);
	check("left for you: the start page lists every item, the status bar counts them, ticking one removes it from data.json",
		shown.items === pluginData().todos.length + 1 && shown.status === `Book Sync: ${shown.items} left for you` && !todoKeys().includes("labels:1000004"),
		JSON.stringify({ shown, keys: todoKeys() }));

	const DONE_NOTE = "Books/Database/Fay Writer - Fill Me.md";
	await cdp.eval(`await app.vault.create(${JSON.stringify(DONE_NOTE)}, "---\\nmedium:\\n---\\n");
		await plugin.addTodos([{ key: "fields:fill-me", text: "Fill Me: fill medium", check: { kind: "noteFields", path: ${JSON.stringify(DONE_NOTE)}, fields: ["medium"] } }]);`);
	const stillOpen = await cdp.eval(`await plugin.checkTodos(); return plugin.todos.some((t) => t.key === "fields:fill-me");`);
	await cdp.eval(`await app.vault.adapter.write(${JSON.stringify(DONE_NOTE)}, "---\\nmedium: paper\\n---\\n"); await plugin.checkTodos();`);
	check("left for you: an item ticks itself off once the field is filled; an offline remote check keeps its items",
		stillOpen && !todoKeys().includes("fields:fill-me") && todoKeys().includes("edition:8001"), JSON.stringify(todoKeys()));

	// --- Labels in the review tab: Hardcover cards start unticked, Tick all, a push into a new list ticks the list too
	hardcoverScenario = writingHardcover;
	await cdp.eval(`await app.vault.adapter.write(${JSON.stringify(BACKLOG_PATH)}, ${JSON.stringify(WRITING_BACKLOG.replace("| Pushed Book | Ada Writer | 2026-10-02 |  |  |", "| Pushed Book | Ada Writer | 2026-10-02 |  | Drama |"))});
		await app.vault.adapter.write(${JSON.stringify(LISTS_PATH)}, ${JSON.stringify(LISTS_FILE)});`);
	const mutationsBefore = writing.mutations.length;
	await cdp.eval(`app.commands.executeCommandById("${PLUGIN_ID}:sync-labels");`);
	await waitUi(`card("push:drama:8001")`);
	const ticked = (id) => `card(${JSON.stringify(id)}).querySelector(".book-sync-tick").checked`;
	const labelsUi = await ui(`
		const hc = () => [...root.querySelectorAll(".book-sync-card.is-hardcover")];
		const start = { hcTicked: hc().filter((c) => c.querySelector(".book-sync-tick").checked).length, hcCount: hc().length };
		card("push:drama:8001").querySelector(".book-sync-summary").click(); await pause(50);
		const both = [${ticked("push:drama:8001")}, ${ticked("list:drama")}];
		card("list:drama").querySelector(".book-sync-summary").click(); await pause(50);
		const neither = [${ticked("push:drama:8001")}, ${ticked("list:drama")}];
		root.querySelector(".book-sync-group.is-hardcover button").click(); await pause(50);
		const all = hc().every((c) => c.querySelector(".book-sync-tick").checked);
		root.querySelector(".book-sync-group.is-hardcover button").click(); await pause(50);
		const none = hc().every((c) => !c.querySelector(".book-sync-tick").checked);
		card("push:drama:8001").querySelector(".book-sync-summary").click(); await pause(50);
		return { start, both, neither, all, none, apply: button("Apply")?.textContent, hcButton: button("Apply")?.classList.contains("is-hardcover") };`);
	await ui(`button("Apply").click();`);
	await waitUi(`button("Finish")`);
	const labelMutations = writing.mutations.slice(mutationsBefore).map((m) => `${m.query} ${JSON.stringify(m.object)}`);
	check("view: labels start with Hardcover unticked; a push into a new list ticks the list, unticking the list unticks the push; Tick all works",
		labelsUi.start.hcTicked === 0 && labelsUi.start.hcCount >= 3 && labelsUi.both.join() === "true,true" && labelsUi.neither.join() === "false,false"
			&& labelsUi.all && labelsUi.none && labelsUi.hcButton === true
			&& labelMutations.length === 2 && labelMutations[0] === 'InsertList {"name":"Drama","privacy_setting_id":1}'
			&& /^InsertListBook \{"list_id":\d+,"book_id":8001\}$/.test(labelMutations[1]),
		JSON.stringify({ labelsUi, labelMutations }));

	await ui(`button("Finish").click();`);
	await waitUi(`root?.querySelector(".book-sync-tally")`);
	const summary = await ui(`return { title: root.querySelector(".book-sync-done h2")?.textContent, rows: [...root.querySelectorAll(".book-sync-tally tr")].map((r) => r.textContent),
		status: document.querySelector(".book-sync-status")?.textContent };`);
	check("view: the summary tallies the run, the status bar says it's finished",
		summary.title === "Sync finished" && summary.rows.length === 1 && /Labels · Sync labels\d+ written/.test(summary.rows[0]) && summary.status === "Book Sync: finished",
		JSON.stringify(summary));
	await ui(`button("Back to Book Sync").click();`);

	// --- Settings (step 6): model dropdown with Custom, and a Test button per key against the fake servers
	hardcoverScenario = (request) => request.query.includes("WhoAmI")
		? { status: 200, body: { data: { me: [{ username: "e2e-reader" }] } } }
		: uiHardcover(request);
	const settingsUi = await cdp.eval(`
		const tab = app.setting.pluginTabs.find((t) => t.id === ${JSON.stringify(PLUGIN_ID)});
		tab.display();
		const item = (name) => [...tab.containerEl.querySelectorAll(".setting-item")].find((el) => el.querySelector(".setting-item-name")?.textContent === name);
		const pause = (ms) => new Promise((r) => setTimeout(r, ms));
		const model = item("OpenAI model");
		const select = model.querySelector("select"), custom = model.querySelector("input");
		const options = [...select.options].map((o) => o.value);
		select.value = "gpt-6-luna"; select.dispatchEvent(new Event("change")); await pause(200);
		const picked = plugin.settings.openaiModel;
		select.value = "__custom__"; select.dispatchEvent(new Event("change"));
		const customShown = custom.style.display !== "none";
		custom.value = "my-fine-tune"; custom.dispatchEvent(new Event("input")); await pause(200);
		const typed = plugin.settings.openaiModel;
		tab.display();
		const reopened = item("OpenAI model").querySelector("select").value;
		plugin.settings.openaiModel = "gpt-6-sol"; await plugin.saveSettings();
		const results = {};
		for (const name of ["Hardcover API token", "OpenAI API key", "Goodreads RSS URL"]) {
			item(name).querySelector("button").click();
			await pause(800);
			results[name] = item(name).querySelector(".book-sync-key-status").textContent;
		}
		return { options, picked, customShown, typed, reopened, results };`);
	check("settings: the model dropdown saves a listed model, Custom takes any id, and a saved custom id shows as Custom",
		settingsUi.options.join() === "gpt-6-luna,gpt-6-sol,gpt-6.1-sol,gpt-6-astra,__custom__" && settingsUi.picked === "gpt-6-luna"
			&& settingsUi.customShown && settingsUi.typed === "my-fine-tune" && settingsUi.reopened === "__custom__",
		JSON.stringify(settingsUi));
	check("settings: each key's Test button reports whether it works",
		settingsUi.results["Hardcover API token"] === "The token works: signed in as e2e-reader."
			&& settingsUi.results["OpenAI API key"] === "The key works."
			&& settingsUi.results["Goodreads RSS URL"] === "The feed works: 4 books on the shelf.",
		JSON.stringify(settingsUi.results));
} catch (err) {
	check("e2e run finished without an exception", false, err.stack ?? String(err));
} finally {
	cdp?.close();
	await closeObsidian();
	await fake?.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
