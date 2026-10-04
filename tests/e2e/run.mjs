// `npm run test:e2e`: runs the built plugin in a real Obsidian on a throwaway vault and checks what a user would check by hand.
// Runs in the background: on an invisible Xvfb screen if installed, otherwise the window flashes once and is hidden
// (E2E_VISIBLE=1 keeps it on screen). Your own Obsidian and vaults are not touched.
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

let cdp;
try {
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
} catch (err) {
	check("e2e run finished without an exception", false, err.stack ?? String(err));
} finally {
	cdp?.close();
	await closeObsidian();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
