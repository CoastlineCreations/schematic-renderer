import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { WorldMeshBuilder } from "./WorldMeshBuilder";
import { SharedMemoryPool } from "./workers/SharedMemoryManager";
import type { SchematicRenderer } from "./SchematicRenderer";
import type { Cubane } from "./cubane";

vi.mock("./workers/MeshBuilder.worker?worker&inline", () => ({ default: class {} }));
vi.mock("./workers/MeshBuilderWasm.worker?worker&inline", () => ({ default: class {} }));

interface BatchMessage {
	type: string;
	batchId?: string;
	chunkId?: string;
	meshContextId?: string;
	chunkOrigin?: number[];
}

function required<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("Expected fixture value");
	return value;
}

function fixture(workerCount = 4) {
	const pending: (() => void)[] = [];
	let pause = true;
	const active = new Set<string>();
	let peakActive = 0;
	const starts = new Map<string, number>();
	const material = new THREE.MeshBasicMaterial();
	const workers = Array.from({ length: workerCount }, () => {
		const worker = {
			onmessage: null as ((event: MessageEvent) => void) | null,
			onerror: null as ((event: ErrorEvent) => void) | null,
			terminate: vi.fn(),
			postMessage: vi.fn((message: BatchMessage) => {
				const send = (data: Record<string, unknown>) =>
					worker.onmessage?.(new MessageEvent("message", { data: { ...message, ...data } }));
				if (message.type === "startBatch") {
					active.add(required(message.batchId));
					peakActive = Math.max(peakActive, active.size);
				} else if (message.type === "buildChunkBatched") {
					if (!starts.has(required(message.batchId)))
						starts.set(required(message.batchId), required(message.chunkOrigin)[0]);
					const reply = () => send({ type: "chunkAccumulated" });
					if (pause) pending.push(reply);
					else queueMicrotask(reply);
				} else if (message.type === "finishBatch") {
					active.delete(required(message.batchId));
					queueMicrotask(() =>
						send({
							type: "batchFinished",
							meshes: [
								{
									category: "solid",
									positions: new Float32Array([
										required(starts.get(required(message.batchId))),
										0,
										0,
									]),
									normals: new Float32Array([0, 1, 0]),
									uvs: new Float32Array([0, 0]),
									indices: new Uint16Array([0]),
									groups: [],
								},
							],
						})
					);
				} else if (message.type === "cancelBatch") active.delete(required(message.batchId));
			}),
		};
		return worker;
	});
	const context = {
		getSharedWorkers: () => workers as unknown as Worker[],
		sharedFreeWorkers: [...workers] as unknown as Worker[],
		sharedWorkerQueue: [] as ((worker: Worker) => void)[],
	};
	const renderer = { options: { context } } as unknown as SchematicRenderer;
	const builder = new WorldMeshBuilder(renderer, {} as Cubane);
	const sibling = new WorldMeshBuilder(renderer, {} as Cubane);
	Reflect.set(builder, "paletteCache", {
		isReady: true,
		palette: [],
		blockData: [],
		globalMaterials: [material],
	});
	const memory = new SharedMemoryPool();
	Reflect.set(builder, "sharedMemoryPool", memory);
	Reflect.set(builder, "useSharedMemory", true);
	const release = vi.spyOn(memory, "releaseBuffers");
	return {
		builder,
		sibling,
		context,
		workers,
		pending,
		active,
		material,
		release,
		peak: () => peakActive,
		resume: () => {
			pause = false;
			pending
				.splice(0)
				.reverse()
				.forEach((reply) => reply());
		},
		dispose: () => {
			builder.dispose();
			sibling.dispose();
			material.dispose();
		},
	};
}

function chunks(count: number) {
	return Array.from({ length: count }, (_, i) => ({
		chunk_x: i,
		chunk_y: 0,
		chunk_z: 0,
		blocks: new Int32Array([i, 0, 0, 0]),
	}));
}

interface PoolAccess {
	getFreeWorker(): Promise<Worker>;
	returnWorker(worker: Worker): void;
}

afterEach(() => vi.useRealTimers());

describe("bounded batch worker scheduling", () => {
	it("uses multiple workers with a 64-chunk total accumulator budget and stable output order", async () => {
		const f = fixture(8);
		const progress = vi.fn();
		const build = f.builder.processChunksBatched(chunks(128), progress);
		await vi.waitFor(() => expect(f.pending).toHaveLength(4));
		expect(f.peak()).toBe(4);
		f.resume();
		const meshes = await build;
		expect(meshes.map((mesh) => mesh.geometry.getAttribute("position").getX(0))).toEqual([
			0, 16, 32, 48, 64, 80, 96, 112,
		]);
		expect(meshes.every((mesh) => (mesh.material as THREE.Material[])[0] === f.material)).toBe(
			true
		);
		expect(f.peak()).toBeLessThanOrEqual(4);
		expect(progress.mock.calls.map(([count]) => count)).toEqual(
			Array.from({ length: 128 }, (_, i) => i + 1)
		);
		expect(f.release).toHaveBeenCalledTimes(128);
		expect(new Set(f.context.sharedFreeWorkers).size).toBe(8);
		expect(f.context.sharedWorkerQueue).toHaveLength(0);
		meshes.forEach((mesh) => mesh.geometry.dispose());
		f.dispose();
	});

	it("drains the current chunk before returning its worker to a queued sibling on cancellation", async () => {
		const f = fixture(1);
		const controller = new AbortController();
		const build = f.builder.processChunksBatched(chunks(128), undefined, controller.signal);
		const rejected = expect(build).rejects.toMatchObject({ name: "AbortError" });
		await vi.waitFor(() => expect(f.pending).toHaveLength(1));
		const siblingPool = f.sibling as unknown as PoolAccess;
		const borrow = siblingPool.getFreeWorker();
		controller.abort();
		expect(f.context.sharedFreeWorkers).toHaveLength(0);
		expect(f.release).not.toHaveBeenCalled();
		f.resume();
		await rejected;
		const worker = await borrow;
		expect(f.release).toHaveBeenCalledOnce();
		expect(
			f.workers[0].postMessage.mock.calls.filter(
				([message]) => message.type === "buildChunkBatched"
			)
		).toHaveLength(1);
		expect(f.active.size).toBe(0);
		siblingPool.returnWorker(worker);
		expect(f.context.sharedFreeWorkers).toHaveLength(1);
		f.dispose();
	});

	it("removes aborted queued acquisitions without taking the sibling's lease", async () => {
		const f = fixture(1);
		const pool = f.sibling as unknown as PoolAccess;
		const lease = await pool.getFreeWorker();
		const controller = new AbortController();
		const build = f.builder.processChunksBatched(chunks(1), undefined, controller.signal);
		const rejected = expect(build).rejects.toMatchObject({ name: "AbortError" });
		expect(f.context.sharedWorkerQueue).toHaveLength(1);
		controller.abort();
		await rejected;
		expect(f.context.sharedWorkerQueue).toHaveLength(0);
		expect(f.workers[0].postMessage).not.toHaveBeenCalled();
		pool.returnWorker(lease);
		expect(f.context.sharedFreeWorkers).toHaveLength(1);
		f.dispose();
	});

	it("settles all lanes and releases shared inputs if one worker reports an error", async () => {
		const f = fixture(4);
		const build = f.builder.processChunksBatched(chunks(128));
		const rejected = expect(build).rejects.toThrow("broken mesh");
		await vi.waitFor(() => expect(f.pending).toHaveLength(4));
		const worker = f.workers[0];
		const message = required(
			worker.postMessage.mock.calls.find(([message]) => message.type === "buildChunkBatched")
		)[0];
		required(worker.onmessage)(
			new MessageEvent("message", { data: { ...message, type: "error", error: "broken mesh" } })
		);
		f.resume();
		await rejected;
		expect(f.release).toHaveBeenCalledTimes(4);
		expect(f.context.sharedFreeWorkers).toHaveLength(4);
		expect(f.active.size).toBe(0);
		f.dispose();
	});

	it("cleans pending requests and leases when message cloning throws", async () => {
		const f = fixture(1);
		f.workers[0].postMessage.mockImplementation((message) => {
			if (message.type === "buildChunkBatched") throw new Error("clone failed");
		});
		await expect(f.builder.processChunksBatched(chunks(1))).rejects.toThrow("clone failed");
		expect(f.release).toHaveBeenCalledOnce();
		expect(Reflect.get(f.builder, "batchRequests").size).toBe(0);
		expect(f.context.sharedFreeWorkers).toHaveLength(1);
		f.dispose();
	});

	it("times out a silent worker without leaking its request or shared input", async () => {
		vi.useFakeTimers();
		const f = fixture(1);
		const build = f.builder.processChunksBatched(chunks(1));
		const rejected = expect(build).rejects.toThrow("Batch build timeout");
		await vi.advanceTimersByTimeAsync(30_000);
		await rejected;
		expect(f.release).toHaveBeenCalledOnce();
		expect(Reflect.get(f.builder, "batchRequests").size).toBe(0);
		expect(f.context.sharedFreeWorkers).toHaveLength(1);
		f.dispose();
	});
});
