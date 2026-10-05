import { beforeAll, describe, expect, it, vi } from "vitest";
import { Schematic } from "nucleation";
import { Group } from "three";
import { SchematicObject } from "../managers/SchematicObject";
import { SchematicWrapper } from "./SchematicWrapper";
import {
	allBlockIndices,
	chunkBlockIndices,
	createChunkIterator,
	getRenderPalette,
	getRenderBounds,
	invalidateRenderSnapshot,
	readRenderSnapshot,
} from "./chunks";

vi.unmock("nucleation");

import { initializeNucleationWasm } from "./runtime";
beforeAll(() => initializeNucleationWasm());

function required<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("Expected fixture value");
	return value;
}

function states(schematic: Schematic) {
	const palette = getRenderPalette(schematic);
	return allBlockIndices(schematic).map(([x, y, z, index]) => ({ x, y, z, ...palette[index] }));
}

describe("native Nucleation indexed render compatibility", () => {
	it("preserves full properties, negative coordinates and region-local palette differences", () => {
		const schematic = Schematic.create("render-regions");
		schematic.setBlock(-2, 1, 3, "minecraft:oak_stairs[facing=north,half=top]");
		schematic.createRegion("other");
		schematic.setBlockInRegion(
			"other",
			48,
			2,
			-17,
			"minecraft:oak_stairs[facing=east,half=bottom]"
		);
		expect(states(schematic)).toEqual(
			expect.arrayContaining([
				{
					x: -2,
					y: 1,
					z: 3,
					name: "minecraft:oak_stairs",
					properties: { facing: "north", half: "top" },
				},
				{
					x: 48,
					y: 2,
					z: -17,
					name: "minecraft:oak_stairs",
					properties: { facing: "east", half: "bottom" },
				},
			])
		);
		expect(allBlockIndices(schematic)).toHaveLength(2);
		const iterator = createChunkIterator(schematic, 8, 8, 8);
		const chunks = [];
		while (iterator.has_next()) chunks.push(required(iterator.next()));
		expect(chunks.map(({ chunk_x, chunk_y, chunk_z }) => [chunk_x, chunk_y, chunk_z])).toEqual([
			[6, 0, -3],
			[-1, 0, 0],
		]);
		iterator.free();
		expect(iterator.has_next()).toBe(false);
	});

	it("uses native region precedence without duplicate geometry, including masking by air", () => {
		const schematic = Schematic.create("overlap");
		schematic.setBlock(0, 0, 0, "minecraft:stone");
		schematic.setBlock(2, 0, 0, "minecraft:stone");
		schematic.createRegion("other");
		schematic.setBlockInRegion("other", 0, 0, 0, "minecraft:gold_block");
		schematic.setBlockInRegion("other", 1, 0, 0, "minecraft:diamond_block");
		expect(schematic.getBlockString(1, 0, 0)).toBe("minecraft:air");
		expect(states(schematic)).toEqual([
			{ x: 0, y: 0, z: 0, name: "minecraft:stone", properties: {} },
			{ x: 2, y: 0, z: 0, name: "minecraft:stone", properties: {} },
		]);
	});

	it("reads bounded sections once and never exposes cached buffers to worker detachment", () => {
		const schematic = jsonOnly(Schematic.create("cache"));
		schematic.setBlock(-17, 0, 0, "minecraft:stone");
		schematic.setBlock(0, 0, 0, "minecraft:oak_stairs[facing=south]");
		const read = vi.spyOn(schematic, "getChunkBlocksJson");
		getRenderPalette(schematic);
		const count = read.mock.calls.length;
		expect(read.mock.calls.every((call) => call.slice(3).every((size) => size === 16))).toBe(true);
		const iterator = createChunkIterator(schematic, 16, 16, 16);
		const chunk = required(iterator.next());
		chunk.blocks.fill(999);
		iterator.free();
		expect(chunkBlockIndices(schematic, -17, 0, 0, 1, 1, 1)[0].slice(0, 3)).toEqual([-17, 0, 0]);
		expect(read).toHaveBeenCalledTimes(count);
		schematic.setBlock(-17, 0, 0, "minecraft:gold_block");
		invalidateRenderSnapshot(schematic);
		expect(states(schematic).find((block) => block.x === -17)?.name).toBe("minecraft:gold_block");
		expect(read.mock.calls.length).toBeGreaterThan(count);
	});

	it("exposes combined tight world bounds for negative and named-region content", () => {
		const wrapper = new SchematicWrapper();
		wrapper.set_block(-2, 1, 3, "minecraft:stone");
		wrapper.native.createRegion("other");
		wrapper.set_block_in_region("other", 48, 2, -17, "minecraft:gold_block");
		expect(Array.from(wrapper.get_tight_dimensions())).toEqual([51, 2, 21]);
		expect(Array.from(required(wrapper.get_tight_bounds_min()))).toEqual([-2, 1, -17]);
		expect(Array.from(required(wrapper.get_tight_bounds_max()))).toEqual([48, 2, 3]);
		const schematic = Object.create(SchematicObject.prototype) as SchematicObject;
		schematic.schematicWrapper = wrapper;
		schematic.group = new Group();
		schematic.group.position.set(10, -1, 5);
		const box = schematic.getTightWorldBox();
		expect(box.min.toArray()).toEqual([8, 0, -12]);
		expect(box.max.toArray()).toEqual([59, 2, 9]);
		wrapper.set_block_in_region("other", 48, 2, -17, "minecraft:air");
		expect(Array.from(wrapper.get_tight_dimensions())).toEqual([1, 1, 1]);
		wrapper.free();
	});

	it("retains named-region content when the default region is empty", () => {
		const schematic = Schematic.create("empty-default");
		schematic.createRegion("other");
		schematic.setBlockInRegion("other", -4, 3, 9, "minecraft:diamond_block");
		expect(states(schematic)).toEqual([
			{ x: -4, y: 3, z: 9, name: "minecraft:diamond_block", properties: {} },
		]);
	});

	it("matches native precedence when removing a block shrinks the default content bounds", () => {
		const schematic = Schematic.create("equal-bounds");
		schematic.setBlock(0, 0, 0, "minecraft:stone");
		schematic.setBlock(2, 0, 0, "minecraft:stone");
		schematic.setBlock(2, 0, 0, "minecraft:air");
		schematic.createRegion("other");
		schematic.setBlockInRegion("other", 0, 0, 0, "minecraft:gold_block");
		schematic.setBlockInRegion("other", 2, 0, 0, "minecraft:diamond_block");
		const atTwo = schematic.getBlockString(2, 0, 0);
		expect(states(schematic)).toEqual([
			{ x: 0, y: 0, z: 0, name: "minecraft:stone", properties: {} },
			...(atTwo === "minecraft:air" ? [] : [{ x: 2, y: 0, z: 0, name: atTwo, properties: {} }]),
		]);
	});

	it("does not read chunks for empty schematics", () => {
		const schematic = Schematic.create("empty");
		const read = vi.spyOn(schematic, "getChunkBlocksJson");
		expect(createChunkIterator(schematic, 16, 16, 16).total_chunks()).toBe(0);
		expect(getRenderPalette(schematic)).toEqual([{ name: "minecraft:air", properties: {} }]);
		expect(read).not.toHaveBeenCalled();
	});
});

type FixtureState = { name: string; properties: [string, string][] };
interface FixtureRegion {
	name: string;
	min: [number, number, number];
	size: [number, number, number];
	palette: FixtureState[];
	blocks: Uint32Array;
}

function typedFixture(regions: FixtureRegion[]) {
	const stateAt = (region: FixtureRegion, x: number, y: number, z: number) => {
		const [rx, ry, rz] = region.min;
		const [w, h, l] = region.size;
		if (x < rx || x >= rx + w || y < ry || y >= ry + h || z < rz || z >= rz + l) return undefined;
		return region.palette[region.blocks[((y - ry) * l + z - rz) * w + x - rx]];
	};
	const metadata = () =>
		regions.map((region) => {
			let contentBounds: { min: number[]; max: number[] } | null = null;
			for (let i = 0; i < region.blocks.length; i++) {
				if (region.palette[region.blocks[i]].name === "minecraft:air") continue;
				const [w, , l] = region.size;
				const position = [
					region.min[0] + (i % w),
					region.min[1] + Math.floor(i / (w * l)),
					region.min[2] + (Math.floor(i / w) % l),
				];
				if (!contentBounds) contentBounds = { min: [...position], max: [...position] };
				else
					for (let axis = 0; axis < 3; axis++) {
						contentBounds.min[axis] = Math.min(contentBounds.min[axis], position[axis]);
						contentBounds.max[axis] = Math.max(contentBounds.max[axis], position[axis]);
					}
			}
			return {
				name: region.name,
				min: region.min,
				size: region.size,
				length: region.blocks.length,
				palette: region.palette,
				contentBounds,
			};
		});
	const composite = (x: number, y: number, z: number) => {
		const metas = metadata();
		for (let i = 0; i < regions.length; i++) {
			const bounds = metas[i].contentBounds;
			if (
				bounds &&
				[x, y, z].every((value, axis) => value >= bounds.min[axis] && value <= bounds.max[axis])
			)
				return stateAt(regions[i], x, y, z);
		}
		return regions.map((region) => stateAt(region, x, y, z)).find(Boolean);
	};
	const api = {
		renderRegionsJson: vi.fn(() => JSON.stringify(metadata())),
		regionBlockIndices: vi.fn((name: string, start: number, count: number) => {
			const region = required(regions.find((region) => region.name === name));
			if (count > 65_536 || start < 0 || start + count > region.blocks.length)
				throw new RangeError("Native window out of bounds");
			return region.blocks.slice(start, start + count);
		}),
		blockCount: () =>
			regions.reduce(
				(count, region) =>
					count +
					region.blocks.filter((index) => region.palette[index].name !== "minecraft:air").length,
				0
			),
		tightBoundsMin: () => {
			const min = required(metadata()[0].contentBounds).min;
			return { x: min[0], y: min[1], z: min[2] };
		},
		tightBoundsMax: () => {
			const max = required(metadata()[0].contentBounds).max;
			return { x: max[0], y: max[1], z: max[2] };
		},
		regionNamesJson: () => JSON.stringify(regions.map((region) => region.name)),
		allPalettesJson: () =>
			JSON.stringify(
				Object.fromEntries(
					regions.map((region, index) => [
						index === 0 ? "default" : region.name,
						region.palette.map((state) => state.name),
					])
				)
			),
		regionBoundingBoxJson: (name: string) => {
			const region =
				name === "default" ? regions[0] : required(regions.find((region) => region.name === name));
			return JSON.stringify([
				...region.min,
				...region.min.map((value, axis) => value + region.size[axis] - 1),
			]);
		},
		getChunkBlocksJson: vi.fn(
			(x: number, y: number, z: number, w: number, h: number, l: number) => {
				const blocks = [];
				for (const region of regions)
					for (let by = y; by < y + h; by++)
						for (let bz = z; bz < z + l; bz++)
							for (let bx = x; bx < x + w; bx++) {
								const state = stateAt(region, bx, by, bz);
								if (state) blocks.push({ ...state, x: bx, y: by, z: bz });
							}
				return JSON.stringify(blocks);
			}
		),
		getBlockString: (x: number, y: number, z: number) => {
			const state = required(composite(x, y, z));
			return (
				state.name +
				(state.properties.length
					? `[${state.properties.map(([key, value]) => `${key}=${value}`).join(",")}]`
					: "")
			);
		},
	};
	return { api, schematic: api as unknown as Schematic };
}

/** Force both extraction paths against the same native engine, including in benchmarks. */
function jsonOnly(schematic: Schematic): Schematic {
	return new Proxy(schematic, {
		get(target, key) {
			if (key === "renderRegionsJson" || key === "regionBlockIndices") return undefined;
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

const fixtureAir: FixtureState = { name: "minecraft:air", properties: [] };
const fixtureStone: FixtureState = { name: "minecraft:stone", properties: [] };

function sortedStates(schematic: Schematic) {
	return states(schematic).sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
}

describe("native typed palette-index streaming", () => {
	it.runIf(typeof Reflect.get(Schematic.prototype, "regionBlockIndices") === "function")(
		"matches JSON fallback against the real native engine without eager block extraction",
		() => {
			const schematic = Schematic.create("native-stream-equivalence");
			for (let x = -3; x < 5; x++)
				for (let z = -2; z < 4; z++) {
					schematic.setBlock(
						x,
						0,
						z,
						(x + z) % 2 ? "minecraft:oak_stairs[facing=east,half=top]" : "minecraft:stone"
					);
				}
			schematic.createRegion("other");
			schematic.setBlockInRegion("other", -2, 0, 0, "minecraft:gold_block");
			schematic.setBlockInRegion(
				"other",
				20,
				1,
				-18,
				"minecraft:oak_stairs[facing=north,half=bottom]"
			);
			const native = schematic as Schematic & {
				regionBlockIndices(name: string, start: number, count: number): Uint32Array;
			};
			const typedRead = vi.spyOn(native, "regionBlockIndices");
			const jsonRead = vi.spyOn(schematic, "getChunkBlocksJson");
			getRenderPalette(schematic);
			getRenderBounds(schematic);
			const iterator = createChunkIterator(schematic, 16, 16, 16);
			expect(typedRead).not.toHaveBeenCalled();
			expect(jsonRead).not.toHaveBeenCalled();
			iterator.next();
			expect(typedRead).toHaveBeenCalled();
			iterator.free();
			const typed = sortedStates(schematic);
			expect(jsonRead).not.toHaveBeenCalled();
			expect(typedRead.mock.calls.every(([, , count]) => count <= 65_536)).toBe(true);
			expect(typed).toEqual(sortedStates(jsonOnly(schematic)));
			expect(jsonRead).toHaveBeenCalled();
		}
	);

	it("loads only metadata until the first requested chunk, with no block JSON", () => {
		const blocks = new Uint32Array(32 ** 3).fill(1);
		const f = typedFixture([
			{
				name: "Main",
				min: [0, 0, 0],
				size: [32, 32, 32],
				palette: [fixtureAir, fixtureStone],
				blocks,
			},
		]);
		expect(getRenderPalette(f.schematic)).toEqual(
			[fixtureAir, fixtureStone].map((state) => ({ name: state.name, properties: {} }))
		);
		expect(getRenderBounds(f.schematic)).toEqual({ min: [0, 0, 0], max: [31, 31, 31] });
		const iterator = createChunkIterator(f.schematic, 16, 16, 16);
		expect(iterator.total_chunks()).toBe(8);
		expect(f.api.regionBlockIndices).not.toHaveBeenCalled();
		expect(f.api.getChunkBlocksJson).not.toHaveBeenCalled();
		const first = required(iterator.next());
		expect(first.blocks.length).toBe(16 ** 3 * 4);
		expect(f.api.regionBlockIndices).toHaveBeenCalled();
		expect(
			f.api.regionBlockIndices.mock.calls.every(
				([, start, count]) => start < 16 * 32 ** 2 && count <= 65_536
			)
		).toBe(true);
		expect(f.api.getChunkBlocksJson).not.toHaveBeenCalled();
		iterator.free();
	});

	it("matches bounded JSON extraction for properties, negative coordinates and overlapping region palettes", () => {
		const north: FixtureState = {
			name: "minecraft:oak_stairs",
			properties: [
				["facing", "north"],
				["half", "top"],
			],
		};
		const east: FixtureState = {
			name: "minecraft:oak_stairs",
			properties: [
				["half", "bottom"],
				["facing", "east"],
			],
		};
		const f = typedFixture([
			{
				name: "Main",
				min: [-3, -1, -2],
				size: [8, 1, 1],
				palette: [fixtureAir, north],
				blocks: new Uint32Array([1, 0, 1, 0, 0, 0, 0, 0]),
			},
			{
				name: "other",
				min: [-3, -1, -2],
				size: [8, 1, 1],
				palette: [fixtureAir, east, fixtureStone],
				blocks: new Uint32Array([2, 1, 0, 0, 0, 0, 0, 1]),
			},
		]);
		const legacy = jsonOnly(f.schematic);
		expect(sortedStates(f.schematic)).toEqual(sortedStates(legacy));
		expect(sortedStates(f.schematic)).toEqual([
			{ x: -3, y: -1, z: -2, name: north.name, properties: Object.fromEntries(north.properties) },
			{ x: -1, y: -1, z: -2, name: north.name, properties: Object.fromEntries(north.properties) },
			{ x: 4, y: -1, z: -2, name: east.name, properties: Object.fromEntries(east.properties) },
		]);
		// The air hole at x=-2 masks a lower stair; padding at x=4 does not.
		expect(chunkBlockIndices(f.schematic, -2, -1, -2, 1, 1, 1)).toEqual([]);
		expect(chunkBlockIndices(f.schematic, 4, -1, -2, 1, 1, 1)).toHaveLength(1);
	});

	it("keeps native reads within the window limit with wide region strides", () => {
		const blocks = new Uint32Array(70_000 * 2);
		blocks[0] = 1;
		blocks[70_000 + 15] = 1;
		const f = typedFixture([
			{
				name: "Main",
				min: [0, 0, 0],
				size: [70_000, 1, 2],
				palette: [fixtureAir, fixtureStone],
				blocks,
			},
		]);
		expect(
			chunkBlockIndices(f.schematic, 0, 0, 0, 16, 1, 2).map((block) => block.slice(0, 3))
		).toEqual([
			[0, 0, 0],
			[15, 0, 1],
		]);
		expect(f.api.regionBlockIndices.mock.calls).toEqual([
			["Main", 0, 16],
			["Main", 70_000, 16],
		]);
	});

	it.each([96, 128, 144, 4096])(
		"bounds total copied indices for a 16³ chunk in a %i-wide region",
		(width) => {
			const f = typedFixture([
				{
					name: "Main",
					min: [0, 0, 0],
					size: [width, 16, 16],
					palette: [fixtureAir, fixtureStone],
					blocks: new Uint32Array(width * 16 * 16).fill(1),
				},
			]);
			const iterator = createChunkIterator(f.schematic, 16, 16, 16);
			expect(f.api.regionBlockIndices).not.toHaveBeenCalled();
			const first = required(iterator.next());
			expect(first.blocks).toHaveLength(4096 * 4);
			expect(first.blocks.slice(0, 4)).toEqual(new Int32Array([0, 0, 0, 1]));
			expect(first.blocks.slice(-4)).toEqual(new Int32Array([15, 15, 15, 1]));
			const copied = f.api.regionBlockIndices.mock.calls.reduce(
				(total, [, , count]) => total + count,
				0
			);
			expect(copied).toBeLessThanOrEqual(4096 * 8);
			if (width === 4096) expect(copied).toBe(4096);
			iterator.free();
		}
	);

	it("bounds its shared cache, refreshing recently read chunks and streaming full extraction", () => {
		const f = typedFixture([
			{
				name: "Main",
				min: [0, 0, 0],
				size: [65 * 16, 1, 1],
				palette: [fixtureAir, fixtureStone],
				blocks: new Uint32Array(65 * 16).fill(1),
			},
		]);
		expect(allBlockIndices(f.schematic)).toHaveLength(65 * 16);
		expect(f.api.regionBlockIndices).toHaveBeenCalledTimes(65);
		const read = (chunk: number) => chunkBlockIndices(f.schematic, chunk * 16, 0, 0, 16, 16, 16);
		read(1); // Refresh the oldest retained chunk.
		expect(f.api.regionBlockIndices).toHaveBeenCalledTimes(65);
		read(0); // Chunk 0 was evicted; its return now evicts chunk 2.
		expect(f.api.regionBlockIndices).toHaveBeenCalledTimes(66);
		read(1);
		expect(f.api.regionBlockIndices).toHaveBeenCalledTimes(66);
		read(2);
		expect(f.api.regionBlockIndices).toHaveBeenCalledTimes(67);
		// Explicit snapshots still own all requested chunks beyond the cache limit.
		const snapshot = readRenderSnapshot(f.schematic);
		expect(snapshot.chunks.size).toBe(65);
		expect(readRenderSnapshot(f.schematic)).toBe(snapshot);
		expect(
			[...snapshot.chunks.values()].reduce((total, chunk) => total + chunk.blocks.length, 0)
		).toBe(65 * 16 * 4);
	});

	it("rejects invalid query origins and extents before reading either native extraction path", () => {
		const f = typedFixture([
			{
				name: "Main",
				min: [0, 0, 0],
				size: [1, 1, 1],
				palette: [fixtureAir, fixtureStone],
				blocks: new Uint32Array([1]),
			},
		]);
		for (const schematic of [f.schematic, jsonOnly(f.schematic)]) {
			for (const value of [NaN, Infinity, -Infinity, 0.5, 2 ** 57, -2_147_483_649]) {
				for (let axis = 0; axis < 3; axis++) {
					const origin: [number, number, number] = [0, 0, 0];
					origin[axis] = value;
					expect(() => chunkBlockIndices(schematic, ...origin, 16, 16, 16)).toThrow(RangeError);
				}
			}
			expect(() => chunkBlockIndices(schematic, 2_147_483_647, 0, 0, 2, 1, 1)).toThrow(RangeError);
		}
		expect(f.api.renderRegionsJson).not.toHaveBeenCalled();
		expect(f.api.regionBlockIndices).not.toHaveBeenCalled();
		expect(f.api.getChunkBlocksJson).not.toHaveBeenCalled();
	});

	it("extracts only selected cells across more underlying sections than the cache retains", () => {
		const width = 65 * 16;
		const f = typedFixture([
			{
				name: "Main",
				min: [-16, -16, -16],
				size: [width, 16, 16],
				palette: [fixtureAir, fixtureStone],
				blocks: new Uint32Array(width * 16 * 16).fill(1),
			},
		]);
		const result = chunkBlockIndices(f.schematic, -15, -7, -3, width - 2, 1, 1);
		expect(result).toHaveLength(width - 2);
		expect(
			result.every(([x, y, z, state], i) => x === i - 15 && y === -7 && z === -3 && state === 1)
		).toBe(true);
		expect(f.api.getChunkBlocksJson).not.toHaveBeenCalled();
	});

	it("preserves cached buffers after transfer and stops stale iterators before further native reads", () => {
		const blocks = new Uint32Array(32).fill(1);
		const f = typedFixture([
			{
				name: "Main",
				min: [0, 0, 0],
				size: [32, 1, 1],
				palette: [fixtureAir, fixtureStone],
				blocks,
			},
		]);
		const iterator = createChunkIterator(f.schematic, 16, 16, 16);
		const first = required(iterator.next());
		structuredClone(first.blocks, { transfer: [first.blocks.buffer] });
		expect(first.blocks.byteLength).toBe(0);
		expect(chunkBlockIndices(f.schematic, 0, 0, 0, 1, 1, 1)[0].slice(0, 3)).toEqual([0, 0, 0]);
		const reads = f.api.regionBlockIndices.mock.calls.length;
		blocks[0] = 0;
		invalidateRenderSnapshot(f.schematic);
		expect(() => iterator.next()).toThrow("Schematic changed during chunk iteration");
		expect(f.api.regionBlockIndices).toHaveBeenCalledTimes(reads);
		iterator.free();
		expect(iterator.has_next()).toBe(false);
		expect(chunkBlockIndices(f.schematic, 0, 0, 0, 1, 1, 1)).toEqual([]);
		expect(f.api.renderRegionsJson).toHaveBeenCalledTimes(2);
	});

	it("keeps custom chunk sizes and invisible-air bounds consistent with JSON extraction", () => {
		const blocks = new Uint32Array(33);
		blocks[0] = 1;
		blocks[16] = 2;
		blocks[32] = 1;
		const f = typedFixture([
			{
				name: "Main",
				min: [-17, 2, 3],
				size: [33, 1, 1],
				palette: [fixtureAir, { name: "minecraft:cave_air", properties: [] }, fixtureStone],
				blocks,
			},
		]);
		expect(getRenderBounds(f.schematic)).toEqual({ min: [-1, 2, 3], max: [-1, 2, 3] });
		expect(sortedStates(f.schematic)).toEqual(sortedStates(jsonOnly(f.schematic)));
		const iterator = createChunkIterator(f.schematic, 8, 4, 5);
		const collected = [];
		while (iterator.has_next()) collected.push(...required(iterator.next()).blocks);
		expect(collected).toEqual([
			-1,
			2,
			3,
			getRenderPalette(f.schematic).findIndex((state) => state.name === "minecraft:stone"),
		]);
		iterator.free();
	});
});
