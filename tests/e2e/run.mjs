// `npm run test:e2e`: runs the built plugin in a real Obsidian on a throwaway vault and checks what a user would check by hand.
// Runs in the background: on an invisible Xvfb screen if installed, otherwise the window flashes once and is hidden
// (E2E_VISIBLE=1 keeps it on screen). Your own Obsidian and vaults are not touched.
import { readFileSync } from "fs";
import { startFakeServer } from "./fakeServer.mjs";
import { closeObsidian, createVault, launchObsidian, PLUGIN_ID, readVaultFile } from "./lib.mjs";

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok });
	console.log(`${ok ? "✔" : "✖"} ${name}${!ok && detail ? `\n    ${detail}` : ""}`);
}

const TOKEN = "fake-hardcover-token-4f9c2e";
const SECRET_NAME = "e2e-openai-key";
const SECRET_VALUE = "fake-openai-key-7d1a";

createVault({ "Books/Want to Read.md": "# Want to Read\n" }, { booksFolder: "Books", legacySetting: "drop me" });

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const HARDCOVER = JSON.parse(fixture("hardcover.json"));
// Answers in order per route; "hardcover" answers are names from tests/fixtures/hardcover.json
const queue = { hardcover: [], openai: [] };
const RSS_PATH = "/review/list_rss/1000?key=E2EKEY&shelf=to-read";

let cdp;
let fake;
try {
	fake = await startFakeServer(({ method, path }) => {
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
		if (method === "POST" && path === "/chat") {
			return queue.openai.shift() ?? { status: 500, body: "no answer queued" };
		}
		return { status: 404, body: "not found" };
	});

	cdp = await launchObsidian();
	await cdp.eval(`app.plugins.setEnable(true); await app.plugins.enablePluginAndSave(${JSON.stringify(PLUGIN_ID)});`);
	await cdp.waitFor(`app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]?.settings`);
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
	const endpoints = JSON.stringify({ hardcover: `${fake.url}/graphql`, goodreads: fake.url, openai: `${fake.url}/chat` });
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
