import { describe, expect, it, vi } from "vitest";
import { Group, Vector3 } from "three";
import type { SchematicObject } from "./managers/SchematicObject";
import { WorldMeshBuilder } from "./WorldMeshBuilder";
import type { SchematicRenderer } from "./SchematicRenderer";
import type { Cubane } from "./cubane";
import type { PaletteEntry } from "./types";

vi.mock("./workers/MeshBuilder.worker?worker&inline", () => ({
	default: class {
		postMessage = vi.fn();
		terminate = vi.fn();
		onmessage = null;
	},
}));
vi.mock("./workers/MeshBuilderWasm.worker?worker&inline", () => ({
	default: class {
		postMessage = vi.fn();
		terminate = vi.fn();
		onmessage = null;
	},
}));

interface PoolAccess {
	getFreeWorker(): Promise<Worker>;
	returnWorker(worker: Worker): void;
}

function sharedFixture() {
	const terminate = vi.fn();
	const postMessage = vi.fn();
	const worker = { terminate, postMessage, onmessage: null } as unknown as Worker;
	const context = {
		getSharedWorkers: () => [worker],
		sharedFreeWorkers: [worker],
		sharedWorkerQueue: [] as ((worker: Worker) => void)[],
	};
	const renderer = {
		options: { context, wasmMeshBuilderOptions: { maxWorkers: 1 } },
	} as unknown as SchematicRenderer;
	const cubane = {} as Cubane;
	const first = new WorldMeshBuilder(renderer, cubane);
	const second = new WorldMeshBuilder(renderer, cubane);
	return {
		context,
		worker,
		terminate,
		postMessage,
		first,
		second,
		firstPool: first as unknown as PoolAccess,
		secondPool: second as unknown as PoolAccess,
	};
}

describe("worker pool teardown", () => {
	it("rejects this builder's queued waiters without removing a sibling's work", async () => {
		const f = sharedFixture();
		const borrowed = await f.firstPool.getFreeWorker();
		const cancelled = f.secondPool.getFreeWorker();
		const rejection = expect(cancelled).rejects.toThrow("disposed");
		f.second.dispose();
		await rejection;
		expect(f.context.sharedWorkerQueue).toHaveLength(0);
		f.firstPool.returnWorker(borrowed);
		expect(await f.firstPool.getFreeWorker()).toBe(f.worker);
		expect(f.terminate).not.toHaveBeenCalled();
		f.first.dispose();
	});

	it("returns borrowed workers exactly once when disposing a shared borrower", async () => {
		const f = sharedFixture();
		const borrowed = await f.firstPool.getFreeWorker();
		const waiting = f.secondPool.getFreeWorker();
		f.first.dispose();
		f.first.dispose();
		expect(await waiting).toBe(borrowed);
		expect(f.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "disposeContext" }));
		f.firstPool.returnWorker(borrowed);
		expect(f.context.sharedFreeWorkers).toHaveLength(0);
		f.secondPool.returnWorker(borrowed);
		expect(f.context.sharedFreeWorkers).toEqual([borrowed]);
		expect(f.terminate).not.toHaveBeenCalled();
		f.second.dispose();
	});

	it("terminates private JavaScript workers even when a resource context is present", () => {
		const renderer = {
			options: { context: {}, wasmMeshBuilderOptions: { enabled: false, maxWorkers: 1 } },
		} as unknown as SchematicRenderer;
		const builder = new WorldMeshBuilder(renderer, {} as Cubane);
		const workers = Reflect.get(builder, "workers") as Worker[];
		builder.dispose();
		builder.dispose();
		expect(workers[0].terminate).toHaveBeenCalledOnce();
	});
});

describe("instanced rendering bounds", () => {
	it("matches the exclusive upper bounds used by chunks and block-entity overlays", async () => {
		const f = sharedFixture();
		const renderBlocksInstanced = vi.fn();
		Reflect.set(f.first, "useInstancedRendering", true);
		Reflect.set(f.first, "instancedRenderer", {
			renderBlocksInstanced,
			disposeInstancedMeshes: vi.fn(),
		});
		const blocks = [
			[0, 0, 0, 0],
			[1, 1, 1, 0],
			[2, 1, 1, 0],
			[1, 2, 1, 0],
			[1, 1, 2, 0],
			[-1, 1, 1, 0],
		];
		const fixture = {
			schematicWrapper: { blocks_indices: () => blocks },
			renderingBounds: { enabled: true, min: new Vector3(0, 0, 0), max: new Vector3(2, 2, 2) },
		};
		await f.first.renderSchematicInstanced(fixture as unknown as SchematicObject);
		expect(renderBlocksInstanced).toHaveBeenLastCalledWith([
			{ x: 0, y: 0, z: 0, paletteIndex: 0 },
			{ x: 1, y: 1, z: 1, paletteIndex: 0 },
		]);
		fixture.renderingBounds.enabled = false;
		await f.first.renderSchematicInstanced(fixture as unknown as SchematicObject);
		expect(renderBlocksInstanced.mock.calls[1][0]).toHaveLength(blocks.length);
		f.first.dispose();
		f.second.dispose();
	});
});

describe("worker dispatch failures", () => {
	it("releases the worker and settles geometry requests when postMessage throws", async () => {
		const f = sharedFixture();
		Reflect.set(f.first, "paletteCache", {
			isReady: true,
			palette: [],
			blockData: [],
			globalMaterials: [],
		});
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		f.postMessage.mockImplementationOnce(() => {
			throw new Error("structured clone failed");
		});
		const result = await f.first.getChunkGeometries({
			chunk_x: 0,
			chunk_y: 0,
			chunk_z: 0,
			blocks: [[0, 0, 0, 0]],
		});
		expect(result).toEqual({ geometries: [], origin: [0, 0, 0] });
		expect(f.context.sharedFreeWorkers).toEqual([f.worker]);
		expect(Reflect.get(f.first, "pendingRequests").size).toBe(0);
		f.first.dispose();
		f.second.dispose();
		errorLog.mockRestore();
	});
});

describe("palette freshness", () => {
	it("recomputes changed middle states even when palette length and endpoints stay unchanged", async () => {
		const f = sharedFixture();
		const getBlockMesh = vi.fn().mockImplementation(async () => new Group());
		Reflect.set(f.first, "cubane", { getBlockMesh });
		const palette: PaletteEntry[] = [
			{ name: "minecraft:stone", properties: {} },
			{ name: "minecraft:redstone_lamp", properties: { lit: "false" } },
			{ name: "minecraft:dirt", properties: {} },
		];
		await f.first.precomputePaletteGeometries(palette);
		getBlockMesh.mockClear();
		const changed = [
			palette[0],
			{ name: "minecraft:redstone_lamp", properties: { lit: "true" } },
			palette[2],
		];
		await f.first.precomputePaletteGeometries(changed);
		expect(getBlockMesh).toHaveBeenCalledWith("minecraft:redstone_lamp[lit=true]", "plains", true);
		getBlockMesh.mockClear();
		await f.first.precomputePaletteGeometries(changed);
		expect(getBlockMesh).not.toHaveBeenCalled();
		f.first.dispose();
		f.second.dispose();
	});
});
