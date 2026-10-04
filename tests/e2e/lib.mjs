// Building blocks for `npm run test:e2e`: a throwaway vault and a second Obsidian instance driven over the
// Chrome DevTools Protocol (CDP). Copied from obsidian-thought-stream (Whisper Buddy), with its own port and plugin id.
// No dependencies: Node 22+ has fetch and WebSocket built in.
import { spawn, execSync } from "child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Paths relative to this file, so the harness works from any working directory
const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(E2E_DIR, "../..");
export const RUN_DIR = path.join(E2E_DIR, ".run");
export const VAULT_DIR = path.join(RUN_DIR, "vault");
const PROFILE_DIR = path.join(RUN_DIR, "profile");
export const PLUGIN_ID = "julius-personal-book-sync";
// Whisper Buddy's e2e uses 9333, so both suites can run at the same time
const CDP_PORT = 9334;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Writes `files` ({"a/b.md": "text"}) into a fresh vault and installs the built plugin with `pluginData` as data.json */
export function createVault(files, pluginData) {
	killTestInstances();
	rmSync(RUN_DIR, { recursive: true, force: true });
	for (const [file, content] of Object.entries(files)) {
		const target = path.join(VAULT_DIR, file);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	const pluginDir = path.join(VAULT_DIR, ".obsidian", "plugins", PLUGIN_ID);
	mkdirSync(pluginDir, { recursive: true });
	for (const file of ["main.js", "manifest.json", "styles.css"]) {
		copyFileSync(path.join(REPO_DIR, file), path.join(pluginDir, file));
	}
	writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify(pluginData, null, 2));

	// A separate profile: Obsidian opens this vault, and the user's own instance and vaults stay untouched
	mkdirSync(PROFILE_DIR, { recursive: true });
	writeFileSync(path.join(PROFILE_DIR, "obsidian.json"), JSON.stringify({
		vaults: { e2etestvault0001: { path: VAULT_DIR, ts: Date.now(), open: true } },
	}));
}

export function readVaultFile(file) {
	return readFileSync(path.join(VAULT_DIR, file), "utf8");
}

export function vaultFileExists(file) {
	return existsSync(path.join(VAULT_DIR, file));
}

// Hides every Obsidian window, also ones opened later (in Obsidian 1.13 settings is its own window).
// Hidden windows keep full-speed timers.
const HIDE_WINDOWS = `
	const remote = window.require("@electron/remote");
	const hide = (win) => { win.webContents.setBackgroundThrottling(false); win.hide(); };
	remote.BrowserWindow.getAllWindows().forEach(hide);
	remote.app.on("browser-window-created", (event, win) => { win.on("show", () => win.hide()); hide(win); });`;

let xvfb = null;
/** "visible", "xvfb" or "hidden", how long a window was on screen before hiding (ms), and the Xvfb display (":99") */
export const displayInfo = { mode: "visible", flashMs: 0, display: null };

/**
 * Where Obsidian's windows go:
 * - E2E_VISIBLE=1: on your screen (for debugging a scenario)
 * - Xvfb installed: an invisible virtual screen, nothing shows and nothing takes focus
 * - otherwise: on your screen for a moment, then hidden
 */
function startDisplay(screen) {
	if (process.env.E2E_VISIBLE) {
		return { env: process.env, hide: false };
	}
	try {
		execSync("command -v Xvfb", { stdio: "ignore" });
	} catch {
		return { env: process.env, hide: true };
	}
	let display = 99;
	while (existsSync(`/tmp/.X11-unix/X${display}`)) {
		display++;
	}
	xvfb = spawn("Xvfb", [`:${display}`, "-screen", "0", `${screen}x24`, "-nolisten", "tcp"], { stdio: "ignore" });
	displayInfo.display = `:${display}`;
	return { env: { ...process.env, DISPLAY: `:${display}`, WAYLAND_DISPLAY: "" }, hide: false, socket: `/tmp/.X11-unix/X${display}` };
}

/**
 * Starts Obsidian on the test vault and returns a CDP connection to its window. `screen`: Xvfb screen size.
 */
export async function launchObsidian({ screen = "1400x900" } = {}) {
	const display = startDisplay(screen);
	displayInfo.mode = display.hide ? "hidden" : display.socket ? "xvfb" : "visible";
	const launchedAt = Date.now();
	for (let i = 0; display.socket && !existsSync(display.socket) && i < 50; i++) {
		await sleep(100);
	}
	const binary = process.env.OBSIDIAN_BIN ?? "obsidian";
	const child = spawn(binary, [
		`--user-data-dir=${PROFILE_DIR}`,
		`--remote-debugging-port=${CDP_PORT}`,
	], { detached: true, stdio: "ignore", env: display.env });
	child.unref();

	let page;
	for (let i = 0; i < 60 && !page; i++) {
		await sleep(500);
		try {
			const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
			page = list.find((p) => p.type === "page" && p.url.startsWith("app://"));
		} catch {
			// not up yet
		}
	}
	if (!page) {
		throw new Error(`Obsidian did not open a debug port on ${CDP_PORT}. Is another test instance still running?`);
	}
	const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
	try {
		if (display.hide) {
			// As early as the renderer allows, to keep the flash short
			for (let i = 0; i < 150; i++) {
				const { result } = await cdp.send("Runtime.evaluate", { expression: `typeof window.require === "function"`, returnByValue: true });
				if (result.value) {
					break;
				}
				await sleep(100);
			}
			await cdp.send("Runtime.evaluate", { expression: HIDE_WINDOWS });
			displayInfo.flashMs = Date.now() - launchedAt;
		}
		await cdp.waitFor(`app.workspace.layoutReady && app.vault.adapter.basePath === ${JSON.stringify(VAULT_DIR)}`, 30000);
	} catch (err) {
		cdp.close();
		await closeObsidian();
		throw err;
	}
	return cdp;
}

// Only processes started with a profile inside RUN_DIR, never the user's Obsidian
function killTestInstances() {
	try {
		execSync(`pkill -f -- "--user-data-dir=${RUN_DIR}"`);
		execSync("sleep 2");
	} catch {
		// none running
	}
}

export async function closeObsidian() {
	try {
		const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
		const browser = await Cdp.connect(version.webSocketDebuggerUrl);
		browser.send("Browser.close").catch(() => {});
		await sleep(1500);
	} catch {
		// already closed
	}
	killTestInstances();
	xvfb?.kill();
	xvfb = null;
}

export class Cdp {
	static async connect(url) {
		const ws = new WebSocket(url);
		await new Promise((resolve, reject) => {
			ws.onopen = resolve;
			ws.onerror = reject;
		});
		return new Cdp(ws);
	}

	constructor(ws) {
		this.ws = ws;
		this.nextId = 1;
		this.pending = new Map();
		this.listeners = new Map();
		ws.onmessage = (message) => {
			const data = JSON.parse(message.data);
			const callback = this.pending.get(data.id);
			if (callback) {
				this.pending.delete(data.id);
				callback(data);
			} else if (data.method) {
				this.listeners.get(data.method)?.forEach((listener) => listener(data.params));
			}
		};
	}

	/** Calls `listener(params)` for every CDP event `method` (e.g. "Fetch.requestPaused") */
	on(method, listener) {
		if (!this.listeners.has(method)) {
			this.listeners.set(method, new Set());
		}
		this.listeners.get(method).add(listener);
		return () => this.listeners.get(method).delete(listener);
	}

	/**
	 * Answers requests to `urlPattern` (e.g. "https://api.openai.com/*") inside Obsidian with `respond(request)` →
	 * `{ status, body }`, so nothing leaves the machine. Returns the intercepted requests and a function that stops it.
	 */
	async intercept(urlPattern, respond) {
		const seen = [];
		const off = this.on("Fetch.requestPaused", ({ requestId, request }) => {
			// CORS preflight: allow it, don't count it
			const { status, body } = request.method === "OPTIONS" ? { status: 204, body: "" } : respond(request);
			if (request.method !== "OPTIONS") {
				seen.push(request);
			}
			this.send("Fetch.fulfillRequest", {
				requestId,
				responseCode: status,
				responseHeaders: [
					{ name: "Content-Type", value: "application/json" },
					{ name: "Access-Control-Allow-Origin", value: "*" },
					{ name: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
					// "*" doesn't cover Authorization
					{ name: "Access-Control-Allow-Headers", value: "authorization, content-type" },
				],
				body: Buffer.from(body).toString("base64"),
			}).catch(() => {});
		});
		await this.send("Fetch.enable", { patterns: [{ urlPattern }] });
		return {
			requests: seen,
			stop: async () => {
				off();
				await this.send("Fetch.disable");
			},
		};
	}

	send(method, params = {}) {
		const id = this.nextId++;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => {
			this.pending.set(id, (data) => data.error ? reject(new Error(data.error.message)) : resolve(data.result));
		});
	}

	/** Runs `body` as an async function inside Obsidian (`app` and `plugin` are in scope) and returns its JSON result */
	async eval(body) {
		const expression = `(async () => { const app = window.app; const plugin = app.plugins.plugins["${PLUGIN_ID}"]; ${body} })()`;
		const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) {
			throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
		}
		return result.result.value;
	}

	/** Polls a JS expression inside Obsidian until it is truthy */
	async waitFor(expression, timeout = 10000) {
		const end = Date.now() + timeout;
		while (Date.now() < end) {
			try {
				if (await this.eval(`return !!(${expression});`)) {
					return;
				}
			} catch {
				// e.g. plugin not loaded yet
			}
			await sleep(200);
		}
		throw new Error(`Timed out after ${timeout} ms waiting for: ${expression}`);
	}

	close() {
		this.ws.close();
	}
}
