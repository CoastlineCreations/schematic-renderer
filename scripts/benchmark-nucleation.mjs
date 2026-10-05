// Compare extraction paths on the same WASM engine; excludes fixture creation and meshing.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import ts from "typescript";
import { Schematic } from "nucleation";

const side = Number(process.env.BENCHMARK_SIDE ?? 96);
const rounds = Number(process.env.BENCHMARK_ROUNDS ?? 3);
const layout = process.env.BENCHMARK_LAYOUT ?? "dense";
if (
	!Number.isSafeInteger(side) ||
	side < 16 ||
	side > 256 ||
	!Number.isSafeInteger(rounds) ||
	rounds < 1 ||
	rounds > 10
) {
	throw new Error("BENCHMARK_SIDE must be 16..256; BENCHMARK_ROUNDS must be 1..10");
}
if (!["dense", "sparse"].includes(layout))
	throw new Error("BENCHMARK_LAYOUT must be dense or sparse");
// chunks.ts has only type imports. Compile it in memory without starting a dev server.
const source = await readFile(new URL("../src/nucleation/chunks.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
	compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { createChunkIterator, getRenderPalette, getRenderBounds, invalidateRenderSnapshot } =
	await import(
		`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString("base64")}`
	);
const schematic = Schematic.create("typed-stream-benchmark");
try {
	if (typeof schematic.renderRegionsJson !== "function") {
		throw new Error("Install the local fork first: npm run nucleation:local");
	}
	const min = -Math.floor(side / 2);
	const max = min + side - 1;
	schematic.fillCuboid(
		min,
		min,
		min,
		max,
		max,
		max,
		layout === "dense" ? "minecraft:stone" : "minecraft:air"
	);
	if (layout === "dense") {
		schematic.fillCuboid(
			min,
			min,
			min,
			max,
			min,
			max,
			"minecraft:oak_stairs[facing=east,half=top]"
		);
	} else {
		for (let y = min; y <= max; y += 8)
			for (let z = min; z <= max; z += 8)
				for (let x = min; x <= max; x += 8)
					schematic.setBlock(x, y, z, "minecraft:oak_stairs[facing=east,half=top]");
		schematic.setBlock(max, max, max, "minecraft:stone");
	}
	const expectedBlocks = schematic.blockCount();
	const hashState = (state) => {
		const text = JSON.stringify([state.name, Object.entries(state.properties ?? {}).sort()]);
		let hash = 0;
		for (const character of text) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
		return hash;
	};
	function measure(handle, mode) {
		const reads = { typedCalls: 0, typedBytes: 0, jsonCalls: 0, jsonCharacters: 0 };
		const native = new Proxy(handle, {
			get(target, key) {
				if (mode === "json" && (key === "renderRegionsJson" || key === "regionBlockIndices"))
					return undefined;
				const value = Reflect.get(target, key, target);
				if (typeof value !== "function") return value;
				return (...args) => {
					const result = value.apply(target, args);
					if (key === "regionBlockIndices") {
						reads.typedCalls++;
						reads.typedBytes += result.byteLength;
					} else if (key === "getChunkBlocksJson") {
						reads.jsonCalls++;
						reads.jsonCharacters += result.length;
					}
					return result;
				};
			},
		});
		globalThis.gc?.();
		const start = performance.now();
		const bounds = getRenderBounds(native);
		const palette = getRenderPalette(native);
		const iterator = createChunkIterator(native, 16, 16, 16);
		const first = iterator.next();
		const firstChunkMs = performance.now() - start;
		const hashes = palette.map(hashState);
		let blocks = 0,
			checksum = 0,
			chunks = 0;
		function consume(chunk) {
			if (!chunk) return;
			chunks++;
			blocks += chunk.blocks.length / 4;
			for (let i = 0; i < chunk.blocks.length; i += 4) {
				const data = chunk.blocks;
				checksum =
					(checksum +
						(Math.imul(data[i], 73856093) ^
							Math.imul(data[i + 1], 19349663) ^
							Math.imul(data[i + 2], 83492791) ^
							hashes[data[i + 3]])) >>>
					0;
			}
		}
		consume(first);
		while (iterator.has_next()) consume(iterator.next());
		const fullScanMs = performance.now() - start;
		iterator.free();
		invalidateRenderSnapshot(native);
		return { firstChunkMs, fullScanMs, blocks, chunks, checksum, bounds, reads };
	}
	// Warm both algorithms on a small independent fixture before recording results.
	const warm = Schematic.create("warm");
	warm.fillCuboid(0, 0, 0, 15, 15, 15, "minecraft:stone");
	measure(warm, "typed");
	measure(warm, "json");
	warm.clearContents();
	const results = { typed: [], json: [] };
	for (let round = 0; round < rounds; round++) {
		for (const mode of round % 2 ? ["json", "typed"] : ["typed", "json"]) {
			results[mode].push(measure(schematic, mode));
		}
	}
	const expected = results.typed[0];
	for (const result of [...results.typed, ...results.json]) {
		assert.equal(result.blocks, expectedBlocks);
		assert.equal(result.checksum, expected.checksum);
		assert.deepEqual(result.bounds, expected.bounds);
	}
	const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
	const summaries = Object.fromEntries(
		Object.entries(results).map(([mode, runs]) => [
			mode,
			{
				firstChunkMs: median(runs.map((run) => run.firstChunkMs)),
				fullScanMs: median(runs.map((run) => run.fullScanMs)),
			},
		])
	);
	console.log(
		JSON.stringify(
			{
				node: process.version,
				side,
				rounds,
				layout,
				cells: side ** 3,
				blocks: expectedBlocks,
				checksum: expected.checksum,
				summaries,
				results,
			},
			null,
			2
		)
	);
} finally {
	invalidateRenderSnapshot(schematic);
	schematic.clearContents?.();
}
