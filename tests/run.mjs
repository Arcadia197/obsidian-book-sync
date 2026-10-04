// `npm test`: bundle tests/*.test.ts with esbuild (same tsconfig paths as the plugin) and run them with Node's test runner.
// Tested modules must not import "obsidian": it only exists inside the app, so the bundle would fail to load.
import esbuild from "esbuild";
import { readdirSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";

const testDir = "tests";
const outDir = path.join(testDir, ".build");
const entryPoints = readdirSync(testDir)
	.filter((file) => file.endsWith(".test.ts"))
	.map((file) => path.join(testDir, file));

rmSync(outDir, { recursive: true, force: true });
await esbuild.build({
	entryPoints,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node18",
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	external: ["obsidian"],
	logLevel: "warning",
});

const builtFiles = entryPoints.map((file) => path.join(outDir, path.basename(file, ".ts") + ".mjs"));
const result = spawnSync(process.execPath, ["--test", ...builtFiles], { stdio: "inherit" });
process.exit(result.status ?? 1);
