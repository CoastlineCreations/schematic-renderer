// Build, validate and install the sibling fork without changing the published dependency.
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--skip-build")) {
	throw new Error(
		"Usage: npm run nucleation:local -- [--skip-build]; set NUCLEATION_PATH for another checkout"
	);
}
const fork = resolve(root, process.env.NUCLEATION_PATH ?? "../nucleation");
const temporary = await mkdtemp(resolve(tmpdir(), "renderer-nucleation-local-"));
const run = (command, arguments_, options = {}) =>
	execFileSync(command, arguments_, { cwd: root, stdio: "inherit", ...options });

try {
	if (!args.includes("--skip-build")) {
		run("bash", ["tools/package-npm.sh", "dist/npm"], {
			cwd: fork,
			env: { ...process.env, RUSTC_WRAPPER: process.env.RUSTC_WRAPPER ?? "" },
		});
		run("bash", ["tools/package-npm.sh", "dist/npm-renderer"], {
			cwd: fork,
			env: {
				...process.env,
				RUSTC_WRAPPER: process.env.RUSTC_WRAPPER ?? "",
				NUCLEATION_WASM_FEATURES: "bridge",
			},
		});
	}
	const staged = resolve(temporary, "package");
	await cp(resolve(fork, "dist/npm"), staged, { recursive: true });
	const rendererEntry = resolve(staged, "renderer");
	await rm(rendererEntry, { recursive: true, force: true });
	await cp(resolve(fork, "dist/npm-renderer"), rendererEntry, { recursive: true });
	await rm(resolve(rendererEntry, "package.json"), { force: true });
	await rm(resolve(rendererEntry, ".build-stamp"), { force: true });
	const cargo = await readFile(resolve(fork, "Cargo.toml"), "utf8");
	const version = cargo.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
	if (!version) throw new Error("Cannot read the fork's Cargo package version");
	const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
		cwd: fork,
		encoding: "utf8",
	}).trim();
	const manifestPath = resolve(staged, "package.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	manifest.version = `${version}-local.${commit}`;
	manifest.private = true;
	await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
	const output = execFileSync(
		"npm",
		[
			"pack",
			staged,
			"--json",
			"--ignore-scripts",
			"--pack-destination",
			temporary,
			"--cache",
			resolve(temporary, "npm-cache"),
		],
		{
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		}
	);
	const [packed] = JSON.parse(output);
	if (!packed?.filename || basename(packed.filename) !== packed.filename) {
		throw new Error("Unexpected npm pack filename");
	}
	const archive = resolve(temporary, packed.filename);
	run(process.execPath, [resolve(fork, "tools/test-npm-package.mjs"), archive, "--with-renderer"]);
	run("npm", [
		"install",
		"--no-save",
		"--package-lock=false",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		archive,
	]);
	console.log(`Local Nucleation ${manifest.version} installed from ${fork}.`);
	console.log(
		"package.json and bun.lock retain the verified registry dependency. Run npm run verify next."
	);
} finally {
	await rm(temporary, { recursive: true, force: true });
}
