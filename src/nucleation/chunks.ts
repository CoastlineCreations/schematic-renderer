import type { Schematic } from "nucleation";
import type { PaletteEntry } from "../types";

interface NativeBlock {
	x: number;
	y: number;
	z: number;
	name: string;
	properties: [string, string][] | Record<string, string>;
}

export interface IndexedChunk {
	chunk_x: number;
	chunk_y: number;
	chunk_z: number;
	blocks: Int32Array;
}

export interface RenderSnapshot {
	bounds: { min: number[]; max: number[] } | null;
	palette: PaletteEntry[];
	chunks: Map<string, IndexedChunk>;
}

const SNAPSHOT_SIDE = 16;
const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);
const snapshots = new WeakMap<Schematic, RenderSnapshot>();
const chunkKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

type Bounds = NonNullable<RenderSnapshot["bounds"]>;
interface NativeRegion {
	name: string;
	min: number[];
	size: number[];
	length: number;
	contentBounds: Bounds | null;
	palette: Pick<NativeBlock, "name" | "properties">[];
}
interface StreamingNative {
	renderRegionsJson(): string;
	regionBlockIndices(region: string, start: number, count: number): Uint32Array;
}
interface StreamingRegion extends NativeRegion {
	paletteIndices: Uint32Array;
}
interface StreamingSource {
	native: StreamingNative;
	regions: StreamingRegion[];
	palette: PaletteEntry[];
	air: Uint8Array;
	chunks: Map<string, IndexedChunk>;
	valid: boolean;
	bounds: Bounds | null | undefined;
}
const streamingSources = new WeakMap<Schematic, StreamingSource>();
const MAX_NATIVE_WINDOW = 65_536;
const MAX_NATIVE_OVERREAD = 8;
// Expanded [x, y, z, palette] tuples use at most 64 KiB per 16³ section.
const MAX_CACHED_CHUNKS = 64;
const EMPTY_BLOCKS = new Int32Array(0);

function streamingSource(schematic: Schematic): StreamingSource | undefined {
	const native = schematic as unknown as Partial<StreamingNative>;
	if (
		typeof native.renderRegionsJson !== "function" ||
		typeof native.regionBlockIndices !== "function"
	)
		return undefined;
	const cached = streamingSources.get(schematic);
	if (cached) return cached;
	const palette: PaletteEntry[] = [{ name: "minecraft:air", properties: {} }];
	const states = new Map([[stateKey(palette[0]), 0]]);
	const regions = (JSON.parse(native.renderRegionsJson()) as NativeRegion[]).map((region) => ({
		...region,
		paletteIndices: Uint32Array.from(region.palette, (block) => {
			const state = normalizedState(block);
			const key = stateKey(state);
			let index = states.get(key);
			if (index === undefined) {
				index = palette.length;
				palette.push(state);
				states.set(key, index);
			}
			return index;
		}),
	}));
	const source: StreamingSource = {
		native: native as StreamingNative,
		regions,
		palette,
		air: Uint8Array.from(palette, (state) => Number(AIR.has(state.name))),
		chunks: new Map(),
		valid: true,
		bounds: undefined,
	};
	streamingSources.set(schematic, source);
	return source;
}

function assertCurrent(source: StreamingSource): void {
	if (!source.valid)
		throw new DOMException("Schematic changed during chunk iteration", "AbortError");
}

function chunkCoordinates(
	source: StreamingSource,
	width: number,
	height: number,
	length: number
): IndexedChunk[] {
	const chunks = new Map<string, IndexedChunk>();
	for (const { contentBounds: bounds } of source.regions) {
		if (!bounds) continue;
		for (let y = Math.floor(bounds.min[1] / height); y <= Math.floor(bounds.max[1] / height); y++) {
			for (
				let z = Math.floor(bounds.min[2] / length);
				z <= Math.floor(bounds.max[2] / length);
				z++
			) {
				for (
					let x = Math.floor(bounds.min[0] / width);
					x <= Math.floor(bounds.max[0] / width);
					x++
				) {
					chunks.set(chunkKey(x, y, z), {
						chunk_x: x,
						chunk_y: y,
						chunk_z: z,
						blocks: EMPTY_BLOCKS,
					});
				}
			}
		}
	}
	return [...chunks.values()];
}

/** Copy only bounded dense source windows; never retain a view into WASM memory. */
function streamedChunk(source: StreamingSource, cx: number, cy: number, cz: number): IndexedChunk {
	assertCurrent(source);
	const key = chunkKey(cx, cy, cz);
	const cached = source.chunks.get(key);
	if (cached) {
		source.chunks.delete(key);
		source.chunks.set(key, cached);
		return cached;
	}
	const x0 = cx * SNAPSHOT_SIDE,
		y0 = cy * SNAPSHOT_SIDE,
		z0 = cz * SNAPSHOT_SIDE;
	const cells = new Int32Array(SNAPSHOT_SIDE ** 3).fill(-1);
	for (const region of source.regions) {
		const bounds = region.contentBounds;
		if (!bounds) continue;
		// Latest Nucleation masks lower regions only inside tight content bounds.
		// Allocated padding is storage, whereas air holes inside content still mask.
		const minX = Math.max(x0, bounds.min[0]),
			maxX = Math.min(x0 + SNAPSHOT_SIDE, bounds.max[0] + 1);
		const minY = Math.max(y0, bounds.min[1]),
			maxY = Math.min(y0 + SNAPSHOT_SIDE, bounds.max[1] + 1);
		const minZ = Math.max(z0, bounds.min[2]),
			maxZ = Math.min(z0 + SNAPSHOT_SIDE, bounds.max[2] + 1);
		if (minX >= maxX || minY >= maxY || minZ >= maxZ) continue;
		const [rx, ry, rz] = region.min;
		const [rw, , rl] = region.size;
		const rowWidth = maxX - minX;
		const windowRows = Math.floor((MAX_NATIVE_WINDOW - rowWidth) / rw) + 1;
		// Gaps between useful rows also cross the WASM boundary. Keep copied
		// indices <= 8x useful cells while retaining row batching for common
		// region widths. Very wide regions read contiguous row slices instead.
		const usefulRows =
			rw > MAX_NATIVE_OVERREAD * rowWidth
				? Math.floor((rw - rowWidth) / (rw - MAX_NATIVE_OVERREAD * rowWidth))
				: Infinity;
		const rowsPerWindow = Math.max(1, Math.min(windowRows, usefulRows));
		for (let y = minY; y < maxY; y++) {
			for (let z = minZ; z < maxZ; z += rowsPerWindow) {
				const rows = Math.min(rowsPerWindow, maxZ - z);
				const start = ((y - ry) * rl + z - rz) * rw + minX - rx;
				const count = (rows - 1) * rw + rowWidth;
				const indices = source.native.regionBlockIndices(region.name, start, count);
				for (let dz = 0; dz < rows; dz++) {
					const target = ((y - y0) * SNAPSHOT_SIDE + z + dz - z0) * SNAPSHOT_SIDE + minX - x0;
					for (let dx = 0; dx < rowWidth; dx++) {
						if (cells[target + dx] === -1)
							cells[target + dx] = region.paletteIndices[indices[dz * rw + dx]];
					}
				}
			}
		}
	}
	let count = 0;
	for (const index of cells) if (index >= 0 && !source.air[index]) count++;
	const blocks = new Int32Array(count * 4);
	let cursor = 0;
	for (let cell = 0; cell < cells.length; cell++) {
		const index = cells[cell];
		if (index < 0 || source.air[index]) continue;
		blocks[cursor++] = x0 + (cell % SNAPSHOT_SIDE);
		blocks[cursor++] = y0 + Math.floor(cell / SNAPSHOT_SIDE ** 2);
		blocks[cursor++] = z0 + (Math.floor(cell / SNAPSHOT_SIDE) % SNAPSHOT_SIDE);
		blocks[cursor++] = index;
	}
	const chunk = { chunk_x: cx, chunk_y: cy, chunk_z: cz, blocks };
	source.chunks.set(key, chunk);
	if (source.chunks.size > MAX_CACHED_CHUNKS) {
		const oldest = source.chunks.keys().next().value;
		if (oldest !== undefined) source.chunks.delete(oldest);
	}
	return chunk;
}

/** Query arbitrary dimensions using cached, independently owned 16³ sections. */
function streamedBox(
	source: StreamingSource,
	x: number,
	y: number,
	z: number,
	width: number,
	height: number,
	length: number
): Int32Array {
	assertCurrent(source);
	if (
		width === SNAPSHOT_SIDE &&
		height === SNAPSHOT_SIDE &&
		length === SNAPSHOT_SIDE &&
		x % SNAPSHOT_SIDE === 0 &&
		y % SNAPSHOT_SIDE === 0 &&
		z % SNAPSHOT_SIDE === 0
	) {
		return streamedChunk(
			source,
			x / SNAPSHOT_SIDE,
			y / SNAPSHOT_SIDE,
			z / SNAPSHOT_SIDE
		).blocks.slice();
	}
	const parts: Int32Array[] = [];
	let count = 0;
	const inside = (blocks: Int32Array, i: number) =>
		blocks[i] >= x &&
		blocks[i] < x + width &&
		blocks[i + 1] >= y &&
		blocks[i + 1] < y + height &&
		blocks[i + 2] >= z &&
		blocks[i + 2] < z + length;
	for (
		let cy = Math.floor(y / SNAPSHOT_SIDE);
		cy <= Math.floor((y + height - 1) / SNAPSHOT_SIDE);
		cy++
	) {
		for (
			let cz = Math.floor(z / SNAPSHOT_SIDE);
			cz <= Math.floor((z + length - 1) / SNAPSHOT_SIDE);
			cz++
		) {
			for (
				let cx = Math.floor(x / SNAPSHOT_SIDE);
				cx <= Math.floor((x + width - 1) / SNAPSHOT_SIDE);
				cx++
			) {
				const blocks = streamedChunk(source, cx, cy, cz).blocks;
				let matching = 0;
				for (let i = 0; i < blocks.length; i += 4) if (inside(blocks, i)) matching++;
				if (!matching) continue;
				count += matching;
				if (matching * 4 === blocks.length) parts.push(blocks);
				else {
					// Retain only the selected cells. Keeping full underlying sections
					// here can amplify memory 256x for long, one-block-wide queries.
					const selected = new Int32Array(matching * 4);
					let cursor = 0;
					for (let i = 0; i < blocks.length; i += 4)
						if (inside(blocks, i)) {
							selected[cursor++] = blocks[i];
							selected[cursor++] = blocks[i + 1];
							selected[cursor++] = blocks[i + 2];
							selected[cursor++] = blocks[i + 3];
						}
					parts.push(selected);
				}
			}
		}
	}
	const result = new Int32Array(count * 4);
	let cursor = 0;
	for (const blocks of parts) {
		result.set(blocks, cursor);
		cursor += blocks.length;
	}
	return result;
}

function extendBounds(bounds: Bounds | null, position: number[]): Bounds {
	if (!bounds) return { min: [...position], max: [...position] };
	for (let axis = 0; axis < 3; axis++) {
		bounds.min[axis] = Math.min(bounds.min[axis], position[axis]);
		bounds.max[axis] = Math.max(bounds.max[axis], position[axis]);
	}
	return bounds;
}

function streamedBounds(source: StreamingSource): Bounds | null {
	assertCurrent(source);
	if (source.bounds !== undefined) return source.bounds;
	let bounds: Bounds | null = null;
	// Region tight bounds count cave/void air as content; the renderer hides them.
	// Metadata cannot distinguish used and stale palette entries, so either
	// kind currently requires block inspection to keep composite bounds exact.
	if (
		source.palette.some(
			(state) => state.name === "minecraft:cave_air" || state.name === "minecraft:void_air"
		)
	) {
		for (const { chunk_x, chunk_y, chunk_z } of chunkCoordinates(source, 16, 16, 16)) {
			const { blocks } = streamedChunk(source, chunk_x, chunk_y, chunk_z);
			for (let i = 0; i < blocks.length; i += 4)
				bounds = extendBounds(bounds, [blocks[i], blocks[i + 1], blocks[i + 2]]);
		}
	} else {
		// Under tight-volume precedence, masking cannot enlarge or shrink this
		// union: a masking region contributes bounds at least as far as its victim.
		for (const region of source.regions)
			if (region.contentBounds) {
				bounds = extendBounds(bounds, region.contentBounds.min);
				bounds = extendBounds(bounds, region.contentBounds.max);
			}
	}
	source.bounds = bounds;
	return bounds;
}

/** Call after every native mutation; snapshots never outlive the native owner. */
export function invalidateRenderSnapshot(schematic: Schematic): void {
	snapshots.delete(schematic);
	const source = streamingSources.get(schematic);
	if (source) {
		source.valid = false;
		source.chunks.clear();
	}
	streamingSources.delete(schematic);
}

function normalizedState(block: Pick<NativeBlock, "name" | "properties">): PaletteEntry {
	return {
		name: block.name,
		properties: Array.isArray(block.properties)
			? Object.fromEntries(block.properties)
			: (block.properties ?? {}),
	};
}

function stateKey(state: PaletteEntry): string {
	return JSON.stringify([state.name, Object.entries(state.properties ?? {}).sort()]);
}

function parseBlockState(value: string): PaletteEntry {
	const bracket = value.indexOf("[");
	if (bracket === -1) return { name: value, properties: {} };
	return {
		name: value.slice(0, bracket),
		properties: Object.fromEntries(
			value
				.slice(bracket + 1, -1)
				.split(",")
				.map((pair) => {
					const equals = pair.indexOf("=");
					return [pair.slice(0, equals), pair.slice(equals + 1)];
				})
		),
	};
}

/**
 * Nucleation 0.10.4 exports palette names without their block-state properties.
 * Read bounded 16³ sections once to recover full states, then retain only compact
 * non-air typed buffers. Avoid serializing or parsing the whole allocated volume.
 */
export function readRenderSnapshot(schematic: Schematic): RenderSnapshot {
	const cached = snapshots.get(schematic);
	if (cached) return cached;
	const source = streamingSource(schematic);
	if (source) {
		const chunks = new Map<string, IndexedChunk>();
		for (const { chunk_x, chunk_y, chunk_z } of chunkCoordinates(source, 16, 16, 16)) {
			const chunk = streamedChunk(source, chunk_x, chunk_y, chunk_z);
			if (chunk.blocks.length) chunks.set(chunkKey(chunk_x, chunk_y, chunk_z), chunk);
		}
		const snapshot = { palette: source.palette, chunks, bounds: streamedBounds(source) };
		snapshots.set(schematic, snapshot);
		return snapshot;
	}
	const snapshot: RenderSnapshot = {
		bounds: null,
		palette: [{ name: "minecraft:air", properties: {} }],
		chunks: new Map(),
	};
	if (schematic.blockCount() === 0) {
		snapshots.set(schematic, snapshot);
		return snapshot;
	}
	// This release's tight bounds describe only the default region.
	let tight: { minimum: number[]; maximum: number[] } | null = null;
	try {
		const min = schematic.tightBoundsMin();
		const max = schematic.tightBoundsMax();
		tight = { minimum: [min.x, min.y, min.z], maximum: [max.x, max.y, max.z] };
	} catch {
		// The default region may be empty while named regions contain blocks.
	}
	const coordinates = new Map<string, [number, number, number]>();
	const regionNames = JSON.parse(schematic.regionNamesJson()) as string[];
	// allPalettesJson exposes named regions verbatim and aliases only the default
	// region as "default". This identifies it without assuming its actual name.
	const namedRegions = new Set(
		Object.keys(JSON.parse(schematic.allPalettesJson()) as Record<string, string[]>).filter(
			(name) => name !== "default"
		)
	);
	const defaultName = regionNames.find((name) => !namedRegions.has(name));
	for (const name of regionNames) {
		const bounds = JSON.parse(schematic.regionBoundingBoxJson(name)) as number[];
		const min = tight && name === defaultName ? tight.minimum : bounds.slice(0, 3);
		const max = tight && name === defaultName ? tight.maximum : bounds.slice(3, 6);
		if (min.some((value, axis) => value > max[axis])) continue;
		for (let y = Math.floor(min[1] / SNAPSHOT_SIDE); y <= Math.floor(max[1] / SNAPSHOT_SIDE); y++) {
			for (
				let z = Math.floor(min[2] / SNAPSHOT_SIDE);
				z <= Math.floor(max[2] / SNAPSHOT_SIDE);
				z++
			) {
				for (
					let x = Math.floor(min[0] / SNAPSHOT_SIDE);
					x <= Math.floor(max[0] / SNAPSHOT_SIDE);
					x++
				) {
					coordinates.set(chunkKey(x, y, z), [x, y, z]);
				}
			}
		}
	}
	const states = new Map([[stateKey(snapshot.palette[0]), 0]]);
	const sorted = [...coordinates.values()].sort(
		(a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]
	);
	for (const [cx, cy, cz] of sorted) {
		const x0 = cx * SNAPSHOT_SIDE,
			y0 = cy * SNAPSHOT_SIDE,
			z0 = cz * SNAPSHOT_SIDE;
		const raw = JSON.parse(
			schematic.getChunkBlocksJson(x0, y0, z0, SNAPSHOT_SIDE, SNAPSHOT_SIDE, SNAPSHOT_SIDE)
		) as NativeBlock[];
		const cells = new Map<number, PaletteEntry>();
		const resolvedOverlaps = new Set<number>();
		for (const block of raw) {
			const cell =
				((block.y - y0) * SNAPSHOT_SIDE + (block.z - z0)) * SNAPSHOT_SIDE + (block.x - x0);
			const state = normalizedState(block);
			const previous = cells.get(cell);
			if (previous && stateKey(previous) !== stateKey(state) && !resolvedOverlaps.has(cell)) {
				// Native chunk reads concatenate regions. Resolve conflicting cells with
				// native composite lookup, including allocated air masking lower regions.
				cells.set(cell, parseBlockState(schematic.getBlockString(block.x, block.y, block.z)));
				resolvedOverlaps.add(cell);
			} else if (!previous) cells.set(cell, state);
		}
		const blocks: number[] = [];
		for (const [cell, state] of [...cells].sort(([a], [b]) => a - b)) {
			if (AIR.has(state.name)) continue;
			const key = stateKey(state);
			let index = states.get(key);
			if (index === undefined) {
				index = snapshot.palette.length;
				snapshot.palette.push(state);
				states.set(key, index);
			}
			const position = [
				x0 + (cell % SNAPSHOT_SIDE),
				y0 + Math.floor(cell / SNAPSHOT_SIDE ** 2),
				z0 + (Math.floor(cell / SNAPSHOT_SIDE) % SNAPSHOT_SIDE),
			];
			const bounds = snapshot.bounds;
			if (!bounds) snapshot.bounds = { min: [...position], max: [...position] };
			else
				position.forEach((value, axis) => {
					bounds.min[axis] = Math.min(bounds.min[axis], value);
					bounds.max[axis] = Math.max(bounds.max[axis], value);
				});
			blocks.push(
				x0 + (cell % SNAPSHOT_SIDE),
				y0 + Math.floor(cell / SNAPSHOT_SIDE ** 2),
				z0 + (Math.floor(cell / SNAPSHOT_SIDE) % SNAPSHOT_SIDE),
				index
			);
		}
		if (blocks.length)
			snapshot.chunks.set(chunkKey(cx, cy, cz), {
				chunk_x: cx,
				chunk_y: cy,
				chunk_z: cz,
				blocks: new Int32Array(blocks),
			});
	}
	snapshots.set(schematic, snapshot);
	return snapshot;
}

export function getRenderBounds(schematic: Schematic): RenderSnapshot["bounds"] {
	const source = streamingSource(schematic);
	return source ? streamedBounds(source) : readRenderSnapshot(schematic).bounds;
}

export function getRenderPalette(schematic: Schematic): PaletteEntry[] {
	return streamingSource(schematic)?.palette ?? readRenderSnapshot(schematic).palette;
}

function validateSize(width: number, height: number, length: number): void {
	if (![width, height, length].every((size) => Number.isSafeInteger(size) && size > 0)) {
		throw new RangeError("Chunk dimensions must be positive integers");
	}
	if (width * height * length > 1_048_576) {
		throw new RangeError("Chunk queries are limited to 1,048,576 cells");
	}
}

function validateOrigin(x: number, y: number, z: number, sizes: number[]): void {
	if (
		[x, y, z].some(
			(value, axis) =>
				!Number.isSafeInteger(value) ||
				value < -2_147_483_648 ||
				value + sizes[axis] - 1 > 2_147_483_647
		)
	) {
		throw new RangeError("Chunk coordinates and their extents must be signed 32-bit integers");
	}
}

export class LazyChunkIterator {
	private chunks: IndexedChunk[];
	private cursor = 0;
	private source: StreamingSource | null = null;
	private dimensions: [number, number, number];

	constructor(
		schematic: Schematic,
		width: number,
		height: number,
		length: number,
		strategy = "bottom_up",
		cameraX = 0,
		cameraY = 0,
		cameraZ = 0
	) {
		validateSize(width, height, length);
		this.dimensions = [width, height, length];
		this.source = streamingSource(schematic) ?? null;
		if (this.source) {
			this.chunks = chunkCoordinates(this.source, width, height, length);
		} else {
			const snapshot = readRenderSnapshot(schematic);
			if (width === SNAPSHOT_SIDE && height === SNAPSHOT_SIDE && length === SNAPSHOT_SIDE) {
				this.chunks = [...snapshot.chunks.values()];
			} else {
				const regrouped = new Map<
					string,
					{ chunk_x: number; chunk_y: number; chunk_z: number; blocks: number[] }
				>();
				for (const { blocks } of snapshot.chunks.values()) {
					for (let i = 0; i < blocks.length; i += 4) {
						const chunk_x = Math.floor(blocks[i] / width),
							chunk_y = Math.floor(blocks[i + 1] / height),
							chunk_z = Math.floor(blocks[i + 2] / length);
						const key = chunkKey(chunk_x, chunk_y, chunk_z);
						let chunk = regrouped.get(key);
						if (!chunk) {
							chunk = { chunk_x, chunk_y, chunk_z, blocks: [] };
							regrouped.set(key, chunk);
						}
						chunk.blocks.push(blocks[i], blocks[i + 1], blocks[i + 2], blocks[i + 3]);
					}
				}
				this.chunks = [...regrouped.values()].map((chunk) => ({
					...chunk,
					blocks: new Int32Array(chunk.blocks),
				}));
			}
		}
		if (strategy === "random") {
			for (let i = this.chunks.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[this.chunks[i], this.chunks[j]] = [this.chunks[j], this.chunks[i]];
			}
		} else {
			if (strategy === "center_outward" && this.chunks.length) {
				const min = [Infinity, Infinity, Infinity],
					max = [-Infinity, -Infinity, -Infinity];
				for (const { chunk_x, chunk_y, chunk_z } of this.chunks) {
					[chunk_x, chunk_y, chunk_z].forEach((value, axis) => {
						min[axis] = Math.min(min[axis], value);
						max[axis] = Math.max(max[axis], value);
					});
				}
				cameraX = ((min[0] + max[0] + 1) * width) / 2;
				cameraY = ((min[1] + max[1] + 1) * height) / 2;
				cameraZ = ((min[2] + max[2] + 1) * length) / 2;
			}
			const distance = ({ chunk_x: x, chunk_y: y, chunk_z: z }: IndexedChunk) =>
				((x + 0.5) * width - cameraX) ** 2 +
				((y + 0.5) * height - cameraY) ** 2 +
				((z + 0.5) * length - cameraZ) ** 2;
			this.chunks.sort((a, b) => {
				if (strategy === "distance_to_camera" || strategy === "center_outward") {
					const delta = distance(a) - distance(b);
					if (delta) return delta;
				}
				return (
					(strategy === "top_down" ? b.chunk_y - a.chunk_y : a.chunk_y - b.chunk_y) ||
					a.chunk_z - b.chunk_z ||
					a.chunk_x - b.chunk_x
				);
			});
		}
	}
	total_chunks(): number {
		return this.chunks.length;
	}
	has_next(): boolean {
		return this.cursor < this.chunks.length;
	}
	next(): IndexedChunk | undefined {
		if (this.source) assertCurrent(this.source);
		const chunk = this.chunks[this.cursor++];
		if (chunk && this.source) {
			const [width, height, length] = this.dimensions;
			return {
				...chunk,
				blocks: streamedBox(
					this.source,
					chunk.chunk_x * width,
					chunk.chunk_y * height,
					chunk.chunk_z * length,
					width,
					height,
					length
				),
			};
		}
		// Worker transfers detach buffers. Never transfer the cached snapshot itself.
		return chunk ? { ...chunk, blocks: chunk.blocks.slice() } : undefined;
	}
	free(): void {
		this.chunks = [];
		this.source = null;
	}
}

export function createChunkIterator(
	schematic: Schematic,
	width: number,
	height: number,
	length: number,
	strategy = "bottom_up",
	cameraX = 0,
	cameraY = 0,
	cameraZ = 0
): LazyChunkIterator {
	return new LazyChunkIterator(
		schematic,
		width,
		height,
		length,
		strategy,
		cameraX,
		cameraY,
		cameraZ
	);
}

export function chunkBlockIndices(
	schematic: Schematic,
	x: number,
	y: number,
	z: number,
	width: number,
	height: number,
	length: number
): number[][] {
	validateSize(width, height, length);
	validateOrigin(x, y, z, [width, height, length]);
	const source = streamingSource(schematic);
	if (source) {
		const blocks = streamedBox(source, x, y, z, width, height, length);
		const result: number[][] = [];
		for (let i = 0; i < blocks.length; i += 4)
			result.push([blocks[i], blocks[i + 1], blocks[i + 2], blocks[i + 3]]);
		return result;
	}
	const snapshot = readRenderSnapshot(schematic);
	const result: number[][] = [];
	for (
		let cy = Math.floor(y / SNAPSHOT_SIDE);
		cy <= Math.floor((y + height - 1) / SNAPSHOT_SIDE);
		cy++
	) {
		for (
			let cz = Math.floor(z / SNAPSHOT_SIDE);
			cz <= Math.floor((z + length - 1) / SNAPSHOT_SIDE);
			cz++
		) {
			for (
				let cx = Math.floor(x / SNAPSHOT_SIDE);
				cx <= Math.floor((x + width - 1) / SNAPSHOT_SIDE);
				cx++
			) {
				const blocks = snapshot.chunks.get(chunkKey(cx, cy, cz))?.blocks;
				if (!blocks) continue;
				for (let i = 0; i < blocks.length; i += 4) {
					const [bx, by, bz, palette] = blocks.subarray(i, i + 4);
					if (bx >= x && bx < x + width && by >= y && by < y + height && bz >= z && bz < z + length)
						result.push([bx, by, bz, palette]);
				}
			}
		}
	}
	return result;
}

export function allBlockIndices(schematic: Schematic): number[][] {
	const result: number[][] = [];
	const source = streamingSource(schematic);
	if (source) {
		for (const { chunk_x, chunk_y, chunk_z } of chunkCoordinates(source, 16, 16, 16)) {
			const { blocks } = streamedChunk(source, chunk_x, chunk_y, chunk_z);
			for (let i = 0; i < blocks.length; i += 4)
				result.push([blocks[i], blocks[i + 1], blocks[i + 2], blocks[i + 3]]);
		}
		return result;
	}
	for (const { blocks } of readRenderSnapshot(schematic).chunks.values()) {
		for (let i = 0; i < blocks.length; i += 4)
			result.push([blocks[i], blocks[i + 1], blocks[i + 2], blocks[i + 3]]);
	}
	return result;
}
