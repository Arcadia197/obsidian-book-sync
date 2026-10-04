// `npm run check:vault`: runs the core parsers against a real Books folder, read-only, and checks that reading and
// re-writing every file gives it back byte for byte. Local only (not in CI): BOOKS_DIR comes from .env.
import esbuild from "esbuild";
import dotenv from "dotenv";
import { spawnSync } from "child_process";
import path from "path";

dotenv.config();
if (!process.env.BOOKS_DIR) {
	console.error("Set BOOKS_DIR in .env to the vault's Books folder (see .env.example).");
	process.exit(1);
}
const outFile = path.join("tests", ".build", "checkVault.mjs");
await esbuild.build({
	entryPoints: [path.join("tests", "vault", "checkVault.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node18",
	outfile: outFile,
	logLevel: "warning",
});
const result = spawnSync(process.execPath, [outFile], { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
