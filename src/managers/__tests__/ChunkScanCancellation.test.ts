import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import * as THREE from "three";
import { SchematicObject } from "../SchematicObject";
import type { SchematicRenderer } from "../../SchematicRenderer";
import type { SchematicWrapper } from "../../nucleationExports";

function fixture(empty: boolean) {
	let scanned = 0;
	const total = 512;
	const iterator = {
		total_chunks: () => total,
		has_next: () => scanned < total,
		next: vi.fn(() => {
			scanned++;
			if (scanned === 1) setTimeout(() => schematic.dispose(), 0);
			return {
				chunk_x: scanned,
				chunk_y: 0,
				chunk_z: 0,
				blocks: empty ? new Int32Array() : new Int32Array([scanned * 16, 0, 0, 1]),
			};
		}),
		free: vi.fn(),
	};
	const builder = {
		precomputePaletteGeometries: vi.fn().mockResolvedValue(undefined),
		getChunkMesh: vi.fn().mockResolvedValue([]),
		processChunksBatched: vi.fn().mockResolvedValue([]),
	};
	const scene = new THREE.Scene();
	const renderer = {
		options: { enableProgressBar: false },
		eventEmitter: new EventEmitter(),
		worldMeshBuilder: builder,
		invalidate: vi.fn(),
	} as unknown as SchematicRenderer;
	const wrapper = {
		get_dimensions: () => [total * 16, 16, 16],
		get_tight_dimensions: () => [total * 16, 16, 16],
		get_all_palettes: () => ({ default: [{ name: "minecraft:stone", properties: {} }] }),
		create_lazy_chunk_iterator: () => iterator,
	} as unknown as SchematicWrapper;
	Object.assign(renderer, {
		sceneManager: {
			scene,
			add: (object: THREE.Object3D) => scene.add(object),
			schematicRenderer: renderer,
		},
	});
	const schematic = new SchematicObject(renderer, "cancellation", wrapper, { visible: false });
	if (!empty) {
		schematic.renderingBounds = {
			enabled: true,
			min: new THREE.Vector3(100_000, 100_000, 100_000),
			max: new THREE.Vector3(100_016, 100_016, 100_016),
		};
	}
	return { schematic, iterator, builder, total, scanned: () => scanned };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("chunk scan cancellation", () => {
	it.each([
		["buildSchematicMeshesIncremental", false],
		["buildSchematicMeshesBatched", true],
		["buildSchematicMeshesImmediate", false],
	] as const)("yields during %s even when no chunks survive filtering", async (method, empty) => {
		vi.useFakeTimers();
		const { schematic, iterator, builder, total, scanned } = fixture(empty);
		const result = schematic[method](schematic).catch((error: unknown) => error);
		await vi.runAllTimersAsync();
		expect(await result).toMatchObject({ name: "AbortError" });
		expect(scanned()).toBeGreaterThan(0);
		expect(scanned()).toBeLessThan(total);
		expect(iterator.free).toHaveBeenCalledOnce();
		expect(builder.getChunkMesh).not.toHaveBeenCalled();
		expect(builder.processChunksBatched).not.toHaveBeenCalled();
	});

	it("yields sooner when individual candidate scans consume the frame budget", async () => {
		vi.useFakeTimers();
		const { schematic, iterator, scanned } = fixture(true);
		vi.spyOn(performance, "now").mockImplementation(() => scanned() * 10);
		const result = schematic
			.buildSchematicMeshesBatched(schematic)
			.catch((error: unknown) => error);
		await vi.runAllTimersAsync();
		expect(await result).toMatchObject({ name: "AbortError" });
		expect(scanned()).toBeGreaterThan(0);
		expect(scanned()).toBeLessThan(64);
		expect(iterator.free).toHaveBeenCalledOnce();
	});
});
