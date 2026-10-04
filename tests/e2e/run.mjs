// `npm run test:e2e`: runs the built plugin in a real Obsidian on a throwaway vault and checks what a user would check by hand.
// Runs in the background: on an invisible Xvfb screen if installed, otherwise the window flashes once and is hidden
// (E2E_VISIBLE=1 keeps it on screen). Your own Obsidian and vaults are not touched.
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { closeObsidian, createVault, launchObsidian, PLUGIN_ID, readVaultFile, VAULT_DIR } from "./lib.mjs";

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok });
	console.log(`${ok ? "✔" : "✖"} ${name}${!ok && detail ? `\n    ${detail}` : ""}`);
}

/** Every file under `dir` whose content contains `needle` */
function filesContaining(dir, needle) {
	const hits = [];
	for (const entry of readdirSync(dir)) {
		const file = path.join(dir, entry);
		if (statSync(file).isDirectory()) {
			hits.push(...filesContaining(file, needle));
		} else if (readFileSync(file, "latin1").includes(needle)) {
			hits.push(file);
		}
	}
	return hits;
}

const SECRET_NAME = "e2e-hardcover-token";
const SECRET_VALUE = "fake-token-4f9c2e";

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
		const secretControls = [...tab.containerEl.querySelectorAll(".setting-item")]
			.filter((el) => ["Hardcover API token", "OpenAI API key", "Goodreads RSS URL"].includes(el.querySelector(".setting-item-name")?.textContent))
			.map((el) => el.querySelector(".setting-item-control").children.length);
		return { names, secretControls };`);
	check("settings tab shows every setting", ["Books folder", "Want to Read file", "Hardcover lists file", "Database folder", "Owner name", "OpenAI model",
		"Hardcover API token", "OpenAI API key", "Goodreads RSS URL"].every((n) => tab.names.includes(n)), JSON.stringify(tab.names));
	check("each secret setting renders a secret picker", tab.secretControls.length === 3 && tab.secretControls.every((n) => n > 0), JSON.stringify(tab.secretControls));
	check("typing in the settings tab saves the trimmed value to data.json", pluginData().booksFolder === "03 - Misc/Books", JSON.stringify(pluginData()));
	await reload();
	check("settings persist across a plugin reload",
		await cdp.eval(`return plugin.settings.booksFolder;`) === "03 - Misc/Books");

	// --- Secrets: data.json holds the secret's name, secretStorage the value
	check("no secret chosen: getSecret is null", await cdp.eval(`return plugin.getSecret("hardcoverTokenSecret");`) === null);
	await cdp.eval(`
		app.secretStorage.setSecret(${JSON.stringify(SECRET_NAME)}, ${JSON.stringify(SECRET_VALUE)});
		plugin.settings.hardcoverTokenSecret = ${JSON.stringify(SECRET_NAME)};
		await plugin.saveSettings();`);
	await reload();
	check("a secret can be set and read back after a reload",
		await cdp.eval(`return plugin.getSecret("hardcoverTokenSecret");`) === SECRET_VALUE);
	check("data.json stores the secret's name, not its value",
		pluginData().hardcoverTokenSecret === SECRET_NAME && !JSON.stringify(pluginData()).includes(SECRET_VALUE));
	const inVault = filesContaining(VAULT_DIR, SECRET_VALUE);
	check("the secret value is nowhere in the vault folder (so vault sync never carries it)", inVault.length === 0, inVault.join(", "));
	check("a chosen but missing secret reads as null", await cdp.eval(`
		plugin.settings.openaiKeySecret = "e2e-does-not-exist";
		return plugin.getSecret("openaiKeySecret");`) === null);
} catch (err) {
	check("e2e run finished without an exception", false, err.stack ?? String(err));
} finally {
	cdp?.close();
	await closeObsidian();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
