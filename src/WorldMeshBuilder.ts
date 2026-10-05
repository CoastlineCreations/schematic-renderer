import * as THREE from "three";
import type { PaletteGeometryData, MeshBuildResult, MeshBlockEntity } from "./workers/types";
import { BlockEntityRendererRegistry } from "./block-entities";
import { getBlockOcclusionFlags } from "./utils/occlusion";
import { SchematicRenderer } from "./SchematicRenderer";
import { SchematicObject } from "./managers/SchematicObject";
import { MaterialRegistry } from "./MaterialRegistry";
import type {
	ChunkMeshes,
	ProcessedBlockGeometry,
	PaletteMaterialGroup,
	PaletteBlockData,
	PaletteCache,
	ChunkGeometryData,
} from "./types";

import { Cubane } from "./cubane";
import { InstancedBlockRenderer } from "./InstancedBlockRenderer";
import { performanceMonitor } from "./performance/PerformanceMonitor";
// Worker imports - Vite handles bundling

import MeshBuilderWorker from "./workers/MeshBuilder.worker?worker&inline";

import MeshBuilderWasmWorker from "./workers/MeshBuilderWasm.worker?worker&inline";
import { GPUCapabilityManager } from "./gpu/GPUCapabilityManager";
import { ComputeMeshBuilder } from "./gpu/ComputeMeshBuilder";
import { getSharedMemoryPool, SharedMemoryPool } from "./workers/SharedMemoryManager";

export const INVISIBLE_BLOCKS = new Set([
	"minecraft:air",
	"minecraft:cave_air",
	"minecraft:void_air",
	"minecraft:structure_void",
	"minecraft:light",
	"minecraft:barrier",
]);

// Constants matching worker
const POSITION_SCALE = 1024;

/**
 * Convert Int8 normals to Float32 for WebGPU compatibility.
 * WebGPU requires vertex buffer strides to be multiples of 4 bytes.
 * Int8 with 3 components has stride 3, which is invalid for WebGPU.
 */
function convertInt8NormalsToFloat32(int8Normals: Int8Array): Float32Array {
	const float32Normals = new Float32Array(int8Normals.length);
	for (let i = 0; i < int8Normals.length; i++) {
		// Normalize from [-128, 127] to [-1.0, 1.0]
		float32Normals[i] = int8Normals[i] / 127.0;
	}
	return float32Normals;
}

export class WorldMeshBuilder {
	private schematicRenderer: SchematicRenderer;
	private cubane: Cubane;
	private paletteCache: PaletteCache | null = null;
	private instancedRenderer: InstancedBlockRenderer | null = null;
	private useInstancedRendering: boolean = false;

	// Worker Pool. Each builder has a unique meshContextId so that when several
	// builders share one context's worker pool, their palettes stay separate in
	// the workers (one WASM MeshBuilder per id). Single-instance use is unaffected.
	private static nextMeshContextId = 0;
	private readonly meshContextId = `mctx-${WorldMeshBuilder.nextMeshContextId++}`;
	private disposed = false;
	private requestSequence = 0;
	private ownsWorkerPool = true;
	private readonly borrowedWorkers = new Set<Worker>();
	private readonly queuedWorkerRequests = new Map<
		(worker: Worker) => void,
		(error: Error) => void
	>();
	private readonly materialReferences = new Map<THREE.Material, number>();
	private readonly ownedMaterials = new WeakSet<THREE.Material>();
	private readonly ownedGeometries = new WeakSet<THREE.BufferGeometry>();
	private readonly paletteGeometries = new Set<THREE.BufferGeometry>();
	private workers: Worker[] = [];
	private freeWorkers: Worker[] = [];
	private workerQueue: ((worker: Worker) => void)[] = []; // Queue for waiting tasks
	private pendingRequests = new Map<
		string,
		{
			resolve: (value: MeshBuildResult) => void;
			reject: (reason?: unknown) => void;
			worker: Worker;
		}
	>();
	// Cap at 8 workers - more than that has diminishing returns and increases startup overhead
	private maxWorkers: number = Math.min(navigator.hardwareConcurrency || 4, 8);

	// Chunk size configuration for buffer sizing
	private chunkSize: number = 16; // Default Minecraft chunk size

	// Phase 2 optimizations configuration
	private useQuantization: boolean = false;

	// WebGPU Compute
	private useGPUCompute: boolean = false;
	private computeMeshBuilder: ComputeMeshBuilder | null = null;
	private gpuInitPromise: Promise<boolean> | null = null;

	// WASM Mesh Builder
	private useWasmMeshBuilder: boolean = false;

	// Timing stats for performance debugging
	private _timingStats: {
		count: number;
		worker: number;
		buffer: number;
		tile: number;
		maxWorker: number;
		maxBuffer: number;
		maxTile: number;
	} | null = null;

	// SharedArrayBuffer for zero-copy transfers
	private sharedMemoryPool: SharedMemoryPool | null = null;
	private useSharedMemory: boolean = false;
	private readonly entitySpatialCaches = new WeakMap<
		Map<string, MeshBlockEntity>,
		Map<number, Map<string, MeshBlockEntity[]>>
	>();
	private readonly blockEntityRenderers: BlockEntityRendererRegistry;

	constructor(schematicRenderer: SchematicRenderer, cubane: Cubane) {
		this.cubane = cubane;
		this.blockEntityRenderers = new BlockEntityRendererRegistry(
			schematicRenderer.options.blockEntityOptions
		);
		this.schematicRenderer = schematicRenderer;
		// Check WASM option (enabled by default)
		this.useWasmMeshBuilder = schematicRenderer.options.wasmMeshBuilderOptions?.enabled ?? true;
		// Check for custom maxWorkers setting
		const configuredMaxWorkers = schematicRenderer.options.wasmMeshBuilderOptions?.maxWorkers;
		if (configuredMaxWorkers && configuredMaxWorkers > 0) {
			this.maxWorkers = configuredMaxWorkers;
		}
		// Try GPU compute first, fall back to workers
		this.initializeGPUCompute();
	}

	/**
	 * Initialize WebGPU compute for mesh building
	 * Falls back to workers if WebGPU is not available
	 */
	private async initializeGPUCompute(): Promise<boolean> {
		if (this.gpuInitPromise) {
			return this.gpuInitPromise;
		}

		this.gpuInitPromise = this._doInitializeGPU();
		return this.gpuInitPromise;
	}

	private async _doInitializeGPU(): Promise<boolean> {
		if (this.disposed) return false;
		try {
			// Check if GPU compute is enabled in options
			const gpuOptions = this.schematicRenderer.options.gpuComputeOptions;
			if (!gpuOptions?.enabled) {
				this.initializeWorkers();
				return false;
			}

			// Check if WebGPU is available
			const isAvailable = await GPUCapabilityManager.isWebGPUAvailable();
			if (this.disposed) return false;
			if (!isAvailable) {
				this.initializeWorkers();
				return false;
			}

			// Initialize compute mesh builder
			this.computeMeshBuilder = new ComputeMeshBuilder();
			const computeBuilder = this.computeMeshBuilder;
			const success = await computeBuilder.initialize();
			if (this.disposed) {
				computeBuilder.dispose();
				return false;
			}

			if (success) {
				this.useGPUCompute = true;
				console.warn("  WARNING: GPU compute is ~6x SLOWER than workers due to GPU→CPU readback!");
				console.warn("  Textures will not render correctly (wireframe only).");
				console.warn("  Set gpuComputeOptions.enabled = false for better performance.");
				return true;
			} else {
				console.warn("[WorldMeshBuilder] GPU compute init failed, using worker fallback");
				this.computeMeshBuilder = null;
				this.initializeWorkers();
				return false;
			}
		} catch (error) {
			console.warn("[WorldMeshBuilder] GPU compute error, using worker fallback:", error);
			this.computeMeshBuilder = null;
			this.initializeWorkers();
			return false;
		}
	}

	/**
	 * Check if GPU compute is being used
	 */
	public isUsingGPUCompute(): boolean {
		return this.useGPUCompute && this.computeMeshBuilder !== null;
	}

	private initializeWorkers() {
		if (this.disposed || this.workers.length > 0) return;

		// Initialize shared memory pool for zero-copy transfers
		this.sharedMemoryPool = getSharedMemoryPool();
		this.useSharedMemory = this.sharedMemoryPool.usingSharedMemory();

		const context = this.schematicRenderer.options.context;
		// Sharing is supported only for the WASM worker (the default), whose palette
		// is namespaced per meshContextId. The JS worker stays per-renderer.
		if (context && this.useWasmMeshBuilder) {
			this.ownsWorkerPool = false;
			// Share one worker pool across every renderer on this context (WASM is
			// initialized once per worker; palettes are namespaced by meshContextId).
			// onmessage is (re)bound per acquire in getFreeWorker, since workers are
			// borrowed exclusively by one builder at a time.
			this.workers = context.getSharedWorkers(this.maxWorkers, true);
			this.freeWorkers = context.sharedFreeWorkers;
			this.workerQueue = context.sharedWorkerQueue;
			return;
		}

		for (let i = 0; i < this.maxWorkers; i++) {
			// Use WASM worker if enabled, otherwise use JavaScript worker
			const worker = this.useWasmMeshBuilder
				? new MeshBuilderWasmWorker()
				: new MeshBuilderWorker();
			worker.onmessage = (event: MessageEvent) => this.handleWorkerMessage(worker, event);
			this.workers.push(worker);
			this.freeWorkers.push(worker);
		}
	}

	/**
	 * Check if using WASM mesh builder
	 */
	public isUsingWasmMeshBuilder(): boolean {
		return this.useWasmMeshBuilder && this.workers.length > 0;
	}

	/**
	 * Check if using SharedArrayBuffer
	 */
	public isUsingSharedMemory(): boolean {
		return this.useSharedMemory && this.sharedMemoryPool !== null;
	}

	// Greedy meshing state
	private greedyMeshingEnabled = false;

	/**
	 * Enable or disable greedy meshing optimization
	 * Greedy meshing merges coplanar faces into larger quads, reducing vertex count significantly
	 */
	public setGreedyMeshing(enabled: boolean): void {
		this.greedyMeshingEnabled = enabled;

		// Notify all workers
		for (const worker of this.workers) {
			worker.postMessage({ type: "setGreedyMeshing", enabled });
		}
	}

	/**
	 * Check if greedy meshing is enabled
	 */
	public isGreedyMeshingEnabled(): boolean {
		return this.greedyMeshingEnabled;
	}

	// Static stats collector
	static stats = {
		totalSetup: 0,
		totalSort: 0,
		totalMerge: 0,
		totalWorkerTime: 0,
		chunkCount: 0,
	};

	static resetStats() {
		this.stats = {
			totalSetup: 0,
			totalSort: 0,
			totalMerge: 0,
			totalWorkerTime: 0,
			chunkCount: 0,
		};
	}

	// Requests are correlated per sub-batch, so several workers can finish out of order.
	private readonly batchRequests = new Map<
		string,
		{
			resolve: (data: MeshBuildResult) => void;
			reject: (error: unknown) => void;
			worker: Worker;
		}
	>();

	private handleWorkerMessage(worker: Worker, event: MessageEvent) {
		const { type, chunkId, batchId, error, timings, meshContextId, ...data } = event.data;
		if (this.disposed || (meshContextId && meshContextId !== this.meshContextId)) return;

		if (type === "chunkBuilt") {
			if (timings) {
				WorldMeshBuilder.stats.totalSetup += timings.setup;
				WorldMeshBuilder.stats.totalSort += timings.sort;
				WorldMeshBuilder.stats.totalMerge += timings.merge;
				WorldMeshBuilder.stats.totalWorkerTime += timings.total;
				WorldMeshBuilder.stats.chunkCount++;

				if (WorldMeshBuilder.stats.chunkCount % 50 === 0) {
					const avg = (val: number) => (val / WorldMeshBuilder.stats.chunkCount).toFixed(2);
					console.log(
						`[WorkerStats] Avg (n=${WorldMeshBuilder.stats.chunkCount}): Setup ${avg(WorldMeshBuilder.stats.totalSetup)}ms, Sort ${avg(WorldMeshBuilder.stats.totalSort)}ms, Merge ${avg(WorldMeshBuilder.stats.totalMerge)}ms, Total ${avg(WorldMeshBuilder.stats.totalWorkerTime)}ms`
					);
				}
			}

			const request = this.pendingRequests.get(chunkId);
			if (request) {
				request.resolve(data);
				this.pendingRequests.delete(chunkId);

				// Return worker to pool
				this.returnWorker(worker);
			}
		} else if (type === "chunkAccumulated" || type === "batchFinished") {
			// A lane retains its lease through finishBatch. Returning on a chunk ACK
			// would let a sibling steal its handler and strand its remaining work.
			const requestId = type === "chunkAccumulated" ? chunkId : batchId;
			const request = this.batchRequests.get(requestId);
			if (request?.worker === worker) {
				this.batchRequests.delete(requestId);
				request.resolve(type === "chunkAccumulated" ? { meshes: [] } : data);
			}
		} else if (type === "error") {
			const requestId = chunkId ?? batchId;
			const batchRequest = this.batchRequests.get(requestId);
			if (batchRequest?.worker === worker) {
				this.batchRequests.delete(requestId);
				batchRequest.reject(new Error(error));
				return;
			}
			if (chunkId) {
				const request = this.pendingRequests.get(chunkId);
				if (request) {
					request.reject(new Error(error));
					this.pendingRequests.delete(chunkId);
					this.returnWorker(worker);
				}
			} else {
				console.error("[WorldMeshBuilder] Worker error:", error);
			}
		} else if (type === "paletteUpdated") {
			// Optional: handle palette update confirmation
		}
	}

	private returnWorker(worker: Worker) {
		if (!this.borrowedWorkers.delete(worker) || !this.workers.includes(worker)) return;

		const resolve = this.workerQueue.shift();
		if (resolve) {
			resolve(worker);
		} else {
			this.freeWorkers.push(worker);
		}
	}

	public setChunkSize(newChunkSize: number): void {
		if (newChunkSize <= 0 || newChunkSize > 64) {
			throw new Error("Chunk size must be between 1 and 64");
		}
		this.chunkSize = newChunkSize;
	}

	public getChunkSize(): number {
		return this.chunkSize;
	}

	public setQuantization(enabled: boolean): void {
		this.useQuantization = enabled;
	}

	public getQuantization(): boolean {
		return this.useQuantization;
	}

	// Removed unused isBlockOccluding method

	private async computeOcclusionFlags(
		blockString: string,
		category: keyof ChunkMeshes = "solid"
	): Promise<number> {
		// Liquids get their own render category and must cull against themselves,
		// like glass-on-glass. Their synthesized model carries no `cullface` and is
		// sub-cube height (14/16), so the generic opaque/full-face path below never
		// flags them and adjacent water faces are never hidden. Treat every face as
		// self-occluding: the worker only culls a face when the SAME-category
		// neighbour has the opposite bit set, so water still won't cull solids, and
		// the worker's flush test keeps the 14/16-high top surface visible.
		if (category === "water") {
			return 0b111111; // all six faces occlude same-category (water) neighbours
		}

		try {
			const data = await this.cubane.getBlockOptimizationData(blockString, "plains", true);
			return getBlockOcclusionFlags(data);
		} catch {
			return 0;
		}
	}

	/**
	 * Invalidate the palette cache to force re-computation of geometries.
	 * Call this when textures/materials change (e.g., resource pack change).
	 */
	public invalidateCache(): void {
		console.log("[WorldMeshBuilder] Invalidating cache");
		for (const geometry of this.paletteGeometries) geometry.dispose();
		this.paletteGeometries.clear();
		this.paletteCache = null;
	}

	public async precomputePaletteGeometries(palette: PaletteCache["palette"]): Promise<void> {
		if (this.disposed) throw new Error("WorldMeshBuilder is disposed");
		performanceMonitor.startOperation("precomputePaletteGeometries");

		const cachedPalette = this.paletteCache;
		// Every entry matters: simulation can change a middle palette state while
		// the first/last entries and total palette size remain unchanged.
		if (
			cachedPalette?.isReady &&
			cachedPalette.palette.length === palette.length &&
			palette.every((entry, index) => {
				const previous = cachedPalette.palette[index];
				return (
					entry.name === previous.name &&
					JSON.stringify(entry.properties) === JSON.stringify(previous.properties)
				);
			})
		) {
			performanceMonitor.endOperation("precomputePaletteGeometries");
			return;
		}

		// Reset stats on start
		WorldMeshBuilder.resetStats();

		// Re-initialize GPU compute if it was disposed (e.g., during cleanup between runs)
		// This must happen BEFORE worker initialization to allow GPU to take precedence
		if (!this.gpuInitPromise && this.schematicRenderer.options.gpuComputeOptions?.enabled) {
			this.gpuInitPromise = this._doInitializeGPU();
		}

		// Wait for GPU init if in progress - GPU init will create workers as fallback if needed
		if (this.gpuInitPromise) {
			await this.gpuInitPromise;
		} else {
			// Only initialize workers if GPU is not being used
			this.initializeWorkers();
		}

		const paletteBlockData: PaletteBlockData[] = new Array(palette.length);
		const globalMaterialMap = new Map<string, THREE.Material>();
		const globalMaterials: THREE.Material[] = [];
		const paletteGeometryData: PaletteGeometryData[] = [];

		// Process all palette entries
		const CONCURRENCY_LIMIT = 8;
		let currentIndex = 0;
		const workerPromises: Promise<void>[] = [];

		const processBlock = async (index: number) => {
			if (this.disposed) return;
			const blockState = palette[index];
			if (this.blockEntityRenderers.handles(blockState.name)) {
				paletteBlockData[index] = {
					blockName: blockState.name,
					materialGroups: [],
					category: "solid",
				};
				return;
			}
			const blockString = this.createBlockStringFromPaletteEntry(blockState);
			const biome = "plains";

			try {
				// Get geometry from Cubane (Main Thread)
				const cubaneObj = await this.cubane.getBlockMesh(blockString, biome, true);
				if (this.disposed) return;
				const extractedGeometries = cubaneObj
					? this.extractAllMeshData(cubaneObj)
					: this.extractAllMeshData(this.createFallbackObject3D(blockString));

				// Create material groups for this block type
				const materialGroups: PaletteMaterialGroup[] = [];
				const geometryData: PaletteGeometryData["geometries"] = [];

				for (const { geometry, material } of extractedGeometries) {
					if (geometry.attributes.position.count === 0) continue;
					this.ownedGeometries.add(geometry);
					this.paletteGeometries.add(geometry);

					// Get or create shared material
					const sharedMaterial = MaterialRegistry.getMaterial(material);
					this.ownedMaterials.add(sharedMaterial);
					this.materialReferences.set(
						sharedMaterial,
						(this.materialReferences.get(sharedMaterial) ?? 0) + 1
					);
					const materialKey = sharedMaterial.uuid;

					// Get or assign global material index
					let globalMaterial = globalMaterialMap.get(materialKey);
					if (!globalMaterial) {
						globalMaterial = sharedMaterial;
						globalMaterialMap.set(materialKey, globalMaterial);
						globalMaterials.push(globalMaterial);
					}

					const materialIndex = globalMaterials.indexOf(globalMaterial);

					materialGroups.push({
						material: globalMaterial,
						baseGeometry: geometry,
						positions: [],
						materialIndex: materialIndex,
					});

					// Extract buffers for worker
					geometryData.push({
						positions: geometry.attributes.position.array,
						normals: geometry.attributes.normal?.array,
						uvs: geometry.attributes.uv?.array,
						indices: geometry.index?.array || null,
						materialIndex: materialIndex,
					});
				}

				const category = this.getBlockCategory(blockState.name, blockState.properties);

				paletteBlockData[index] = {
					blockName: blockState.name,
					materialGroups,
					category,
				};

				// Add to worker payload
				if (geometryData.length > 0) {
					const occlusionFlags = await this.computeOcclusionFlags(blockString, category);
					paletteGeometryData.push({
						index,
						category,
						occlusionFlags: occlusionFlags,
						isCubic: occlusionFlags === 63, // Optimization: All 6 faces are occluding = full cube
						geometries: geometryData,
					});
				}
			} catch (error) {
				console.warn(`Error processing palette index ${index}:`, error);
			}
		};

		// Process with concurrency limit
		while (currentIndex < palette.length || workerPromises.length > 0) {
			while (workerPromises.length < CONCURRENCY_LIMIT && currentIndex < palette.length) {
				const index = currentIndex++;
				const promise = processBlock(index).then(() => {
					const idx = workerPromises.indexOf(promise);
					if (idx > -1) workerPromises.splice(idx, 1);
				});
				workerPromises.push(promise);
			}

			if (workerPromises.length > 0) {
				await Promise.race(workerPromises.map((p) => p.catch(() => {})));
			} else if (currentIndex >= palette.length) {
				break;
			}
		}

		if (this.disposed) {
			for (const block of paletteBlockData) {
				block?.materialGroups.forEach((group) => {
					if (this.paletteGeometries.delete(group.baseGeometry)) group.baseGeometry.dispose();
				});
			}
			throw new Error("WorldMeshBuilder is disposed");
		}

		this.paletteCache = {
			palette: palette,
			blockData: paletteBlockData,
			globalMaterials,
			isReady: true,
		};

		// Wait for GPU init to complete
		if (this.gpuInitPromise) {
			await this.gpuInitPromise;
		}

		// Upload to GPU if using GPU compute, otherwise broadcast to workers
		if (this.useGPUCompute && this.computeMeshBuilder) {
			await this.computeMeshBuilder.uploadPaletteData(this.paletteCache);
		} else {
			this.workers.forEach((worker) => {
				worker.postMessage({
					type: "updatePalette",
					paletteData: paletteGeometryData,
					meshContextId: this.meshContextId,
				});
			});
		}
	}

	// Helper to acquire a worker. Rebinds onmessage to THIS builder so that, with a
	// shared pool, responses route back to the builder that borrowed the worker
	// (workers are lent exclusively until returnWorker).
	private async getFreeWorker(signal?: AbortSignal): Promise<Worker> {
		signal?.throwIfAborted();
		if (this.disposed) throw new Error("WorldMeshBuilder is disposed");
		const bind = (worker: Worker): Worker => {
			this.borrowedWorkers.add(worker);
			worker.onmessage = (event: MessageEvent) => this.handleWorkerMessage(worker, event);
			worker.onerror = (event: ErrorEvent) => {
				const error = new Error(event.message || "Mesh worker failed");
				for (const [id, request] of this.pendingRequests) {
					if (request.worker === worker) {
						this.pendingRequests.delete(id);
						request.reject(error);
						this.returnWorker(worker);
					}
				}
				for (const [id, request] of this.batchRequests) {
					if (request.worker === worker) {
						this.batchRequests.delete(id);
						request.reject(error);
					}
				}
			};
			return worker;
		};
		const availableWorker = this.freeWorkers.pop();
		if (availableWorker) return bind(availableWorker);
		return new Promise<Worker>((resolve, reject) => {
			const cancel = () => {
				const index = this.workerQueue.indexOf(queued);
				if (index >= 0) this.workerQueue.splice(index, 1);
				this.queuedWorkerRequests.delete(queued);
				signal?.removeEventListener("abort", cancel);
				reject(signal?.reason);
			};
			const queued = (worker: Worker): void => {
				signal?.removeEventListener("abort", cancel);
				this.queuedWorkerRequests.delete(queued);
				resolve(bind(worker));
			};
			this.queuedWorkerRequests.set(queued, (error) => {
				signal?.removeEventListener("abort", cancel);
				reject(error);
			});
			this.workerQueue.push(queued);
			signal?.addEventListener("abort", cancel, { once: true });
		});
	}

	private requestBatch(
		worker: Worker,
		requestId: string,
		message: Record<string, unknown>,
		transfer: Transferable[] = []
	): Promise<MeshBuildResult> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.batchRequests.delete(requestId);
				reject(new Error(`Batch build timeout for ${requestId}`));
			}, 30_000);
			this.batchRequests.set(requestId, {
				resolve: (data) => {
					clearTimeout(timeout);
					resolve(data);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
				worker,
			});
			try {
				worker.postMessage(message, transfer);
			} catch (error) {
				clearTimeout(timeout);
				this.batchRequests.delete(requestId);
				reject(error);
			}
		});
	}

	/** Materials borrowed by chunk meshes must outlive individual schematic objects. */
	public ownsGeometry(geometry: THREE.BufferGeometry): boolean {
		return this.ownedGeometries.has(geometry);
	}

	public ownsMaterial(material: THREE.Material): boolean {
		return this.ownedMaterials.has(material);
	}

	/**
	 * Process all chunks in batch mode - returns merged meshes
	 * instead of one mesh per chunk. This reduces main thread work significantly.
	 *
	 * CRITICAL: We split into sub-batches to avoid creating meshes that are too large.
	 * Without this, a 256³ schematic creates 3 meshes with millions of vertices = crash.
	 *
	 * @param allChunks - Iterator or array of chunk data
	 * @param onProgress - Optional progress callback
	 * @returns Promise with merged meshes
	 */
	public async processChunksBatched(
		allChunks: Array<{
			blocks: Int32Array | number[][];
			chunk_x: number;
			chunk_y: number;
			chunk_z: number;
			// Neighbouring chunks' boundary blocks for cross-chunk face culling (occlusion only).
			apronBlocks?: Int32Array;
		}>,
		onProgress?: (processed: number, total: number) => void,
		signal?: AbortSignal
	): Promise<THREE.Mesh[]> {
		signal?.throwIfAborted();
		if (!this.paletteCache?.isReady) {
			throw new Error("Palette cache not ready. Call precomputePaletteGeometries() first.");
		}
		if (!this.useWasmMeshBuilder) {
			throw new Error("Batched meshing requires the WASM mesh builder.");
		}
		if (this.workers.length === 0) this.initializeWorkers();
		if (this.disposed) throw new Error("WorldMeshBuilder is disposed");
		if (allChunks.length === 0) return [];

		// Cap aggregate accumulator memory at the old 64-chunk budget. Four lanes
		// overlap CPU work without multiplying the peak unmerged geometry by eight.
		const concurrency = Math.min(this.workers.length, 4, Math.ceil(allChunks.length / 16));
		const subBatchSize = Math.min(
			Math.floor(64 / concurrency),
			Math.ceil(allChunks.length / concurrency)
		);
		const materials = this.paletteCache.globalMaterials;
		const results: THREE.Mesh[][] = [];
		const controller = new AbortController();
		const abort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", abort, { once: true });
		let nextStart = 0;
		let processed = 0;

		const checkCancelled = () => {
			controller.signal.throwIfAborted();
			if (this.disposed) throw new Error("WorldMeshBuilder is disposed");
		};
		const runLane = async () => {
			try {
				while (nextStart < allChunks.length) {
					checkCancelled();
					const start = nextStart;
					nextStart += subBatchSize;
					const batchId = `${this.meshContextId}:batch:${this.requestSequence++}`;
					const worker = await this.getFreeWorker(controller.signal);
					let finished = false;
					try {
						checkCancelled();
						worker.postMessage({ type: "startBatch", batchId, meshContextId: this.meshContextId });
						for (
							let index = start;
							index < Math.min(start + subBatchSize, allChunks.length);
							index++
						) {
							checkCancelled();
							const chunkData = allChunks[index];
							const blocks =
								chunkData.blocks instanceof Int32Array
									? chunkData.blocks
									: new Int32Array(chunkData.blocks.length * 4);
							if (!(chunkData.blocks instanceof Int32Array)) {
								chunkData.blocks.forEach((block, i) => blocks.set(block, i * 4));
							}
							let x = Infinity,
								y = Infinity,
								z = Infinity;
							for (let i = 0; i < blocks.length; i += 4) {
								x = Math.min(x, blocks[i]);
								y = Math.min(y, blocks[i + 1]);
								z = Math.min(z, blocks[i + 2]);
							}
							const origin = [
								Number.isFinite(x) ? x : 0,
								Number.isFinite(y) ? y : 0,
								Number.isFinite(z) ? z : 0,
							];
							const chunkId = `${batchId}:chunk:${index}`;
							const sharedInputBuffer =
								this.useSharedMemory && this.sharedMemoryPool
									? this.sharedMemoryPool.writeChunkInput(
											chunkId,
											blocks,
											origin[0],
											origin[1],
											origin[2]
										)
									: undefined;
							try {
								// Cancellation waits for this ACK: the worker must finish reading
								// shared input before its buffer or exclusive lease can be reused.
								await this.requestBatch(
									worker,
									chunkId,
									{
										type: "buildChunkBatched",
										chunkId,
										batchId,
										blocks: sharedInputBuffer ? undefined : blocks,
										sharedInputBuffer,
										chunkOrigin: origin,
										apronBlocks: chunkData.apronBlocks,
										meshContextId: this.meshContextId,
									},
									sharedInputBuffer ? [] : [blocks.buffer]
								);
							} finally {
								if (sharedInputBuffer) this.sharedMemoryPool?.releaseBuffers(chunkId);
							}
							checkCancelled();
							onProgress?.(++processed, allChunks.length);
						}
						const result = await this.requestBatch(worker, batchId, {
							type: "finishBatch",
							batchId,
							meshContextId: this.meshContextId,
						});
						finished = true;
						checkCancelled();
						results[start] = this.createMeshesFromBatchResult(result, materials);
					} finally {
						try {
							if (!finished && !this.disposed)
								worker.postMessage({
									type: "cancelBatch",
									batchId,
									meshContextId: this.meshContextId,
								});
						} finally {
							this.returnWorker(worker);
						}
					}
					// Return the lease before yielding, letting other views advance in FIFO order.
					if (nextStart < allChunks.length)
						await new Promise<void>((resolve) => setTimeout(resolve, 0));
				}
			} catch (error) {
				controller.abort(error);
				throw error;
			}
		};

		try {
			// Wait for every lane to drain before disposing its partial output.
			const settled = await Promise.allSettled(Array.from({ length: concurrency }, runLane));
			const failure = settled.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
			checkCancelled();
			return results.flat();
		} catch (error) {
			for (const meshes of results) for (const mesh of meshes ?? []) mesh.geometry.dispose();
			throw error;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	/**
	 * Helper to create Three.js meshes from a batch result
	 */
	private createMeshesFromBatchResult(
		batchResult: MeshBuildResult,
		materials: THREE.Material[]
	): THREE.Mesh[] {
		const meshes: THREE.Mesh[] = [];

		for (const meshData of batchResult.meshes) {
			// OPTIMIZATION: Sort geometry by material index to minimize draw calls
			// Even within a single mesh, multiple groups cause multiple draw calls
			const optimized = this.optimizeGeometryGroups(meshData);

			const geometry = new THREE.BufferGeometry();

			if (optimized.positions) {
				const posAttr = new THREE.BufferAttribute(optimized.positions, 3);
				geometry.setAttribute("position", posAttr);
			}

			if (optimized.normals) {
				const normAttr = new THREE.BufferAttribute(optimized.normals, 3);
				geometry.setAttribute("normal", normAttr);
			}

			if (optimized.uvs) {
				const uvAttr = new THREE.BufferAttribute(optimized.uvs, 2);
				geometry.setAttribute("uv", uvAttr);
			}

			if (optimized.indices) {
				geometry.setIndex(new THREE.BufferAttribute(optimized.indices, 1));
			}

			if (optimized.groups) {
				for (const group of optimized.groups) {
					geometry.addGroup(group.start, group.count, group.materialIndex);
				}
			}

			const mesh = new THREE.Mesh(geometry, materials);
			mesh.name = `batched_${meshData.category}`;

			this.configureMeshForCategory(mesh, meshData.category as keyof ChunkMeshes);
			meshes.push(mesh);
		}

		return meshes;
	}

	/**
	 * OPTIMIZATION: Sort geometry data by material index to merge groups
	 * This reduces draw calls from N_blocks to N_materials per mesh
	 */
	private optimizeGeometryGroups(meshData: ChunkGeometryData): ChunkGeometryData {
		if (!meshData.groups || meshData.groups.length <= 1) {
			// Pre-convert normals if needed
			if (meshData.normals && meshData.normals instanceof Int8Array) {
				meshData.normals = convertInt8NormalsToFloat32(meshData.normals);
			}
			return meshData;
		}

		// Check if already sorted/minimal (heuristic: count groups vs materials)
		// If groups.length is huge but unique materials is small, we need to optimize
		const uniqueMaterials = new Set(meshData.groups.map((g) => g.materialIndex)).size;
		if (meshData.groups.length <= uniqueMaterials * 1.5) {
			// Already optimized enough
			if (meshData.normals && meshData.normals instanceof Int8Array) {
				meshData.normals = convertInt8NormalsToFloat32(meshData.normals);
			}
			return meshData;
		}

		// Prepare new arrays
		const positions = meshData.positions;
		const normals = meshData.normals; // Int8Array usually
		const uvs = meshData.uvs;
		const indices = meshData.indices;

		// const vertexCount = positions.length / 3;
		// const indexCount = indices ? indices.length : vertexCount;

		// We need to reorder everything based on material index
		// 1. Group all existing groups by material index
		const groupsByMaterial = new Map<number, ChunkGeometryData["groups"]>();
		for (const group of meshData.groups) {
			const groups = groupsByMaterial.get(group.materialIndex) ?? [];
			groups.push(group);
			groupsByMaterial.set(group.materialIndex, groups);
		}

		// 2. Calculate new size (same as old)
		// const newPositions = new Float32Array(positions.length);
		// const newNormals = normals ? new Float32Array(normals.length) : null;
		// const newUVs = uvs ? new Float32Array(uvs.length) : null;
		// Use same type for indices (Uint16 or Uint32)
		const NewIndexType = indices instanceof Uint16Array ? Uint16Array : Uint32Array;
		const newIndices = new NewIndexType(indices.length);

		const newGroups: ChunkGeometryData["groups"] = [];
		let currentIndexOffset = 0;
		const currentVertexOffset = 0; // Only relevant if not using indices (unlikely)

		// 3. Iterate materials and rebuild buffers
		for (const [materialIndex, groups] of groupsByMaterial.entries()) {
			const groupStart = newIndices ? currentIndexOffset : currentVertexOffset;
			let groupCount = 0;

			for (const group of groups) {
				// Copy data for this group
				// Note: Groups refer to INDICES range (start, count)
				// But vertices are not necessarily contiguous for the group!
				// Wait, standard Three.js groups just define a range of the INDEX buffer to render.
				// If the index buffer points to vertices all over the place, that's fine.
				// BUT we want to make the INDEX buffer contiguous for this material.

				if (newIndices && indices) {
					// Copy indices for this group
					// We can copy them directly, but we need to verify if vertices need reordering.
					// If we just reorder indices, that's enough for draw calls!
					// Vertices can stay where they are.
					// Optimization: Just reorder indices.

					const sourceStart = group.start;
					const count = group.count;

					// Copy slice of indices
					const subIndices = indices.subarray(sourceStart, sourceStart + count);
					newIndices.set(subIndices, currentIndexOffset);

					currentIndexOffset += count;
					groupCount += count;
				} else {
					// Non-indexed geometry: we must move vertices.
					// This is rarer but possible.
					// We assume indexed for now as WorldMeshBuilder generates indices.
				}
			}

			newGroups.push({
				start: groupStart,
				count: groupCount,
				materialIndex: materialIndex,
			});
		}

		// 4. Handle Normals conversion
		let finalNormals = normals;
		if (normals && normals instanceof Int8Array) {
			finalNormals = convertInt8NormalsToFloat32(normals);
		}

		// If we only reordered indices, we can reuse vertex buffers!
		// This is much faster than moving vertices.
		if (newIndices) {
			return {
				positions: positions, // Unchanged
				normals: finalNormals, // Converted but order unchanged
				uvs: uvs, // Unchanged
				indices: newIndices, // REORDERED
				groups: newGroups, // OPTIMIZED
				category: meshData.category,
			};
		}

		// Fallback for non-indexed (should not happen with current builder)
		return meshData;
	}

	public async getChunkGeometries(
		chunkData: {
			blocks: Array<number[]> | Int32Array;
			chunk_x: number;
			chunk_y: number;
			chunk_z: number;
		},
		renderingBounds?: {
			min: THREE.Vector3;
			max: THREE.Vector3;
			enabled?: boolean;
		}
	): Promise<{ geometries: ChunkGeometryData[]; origin: number[] }> {
		const chunkId = `${this.meshContextId}:${this.requestSequence++}:${chunkData.chunk_x},${chunkData.chunk_y},${chunkData.chunk_z}`;

		if (!this.paletteCache?.isReady) {
			throw new Error("Palette cache not ready. Call precomputePaletteGeometries() first.");
		}

		if (chunkData.blocks.length === 0) return { geometries: [], origin: [0, 0, 0] };

		// Filter blocks based on bounds
		let blocksToProcess = chunkData.blocks;
		if (renderingBounds?.enabled) {
			if (chunkData.blocks instanceof Int32Array) {
				const filtered: number[] = [];
				const blocks = chunkData.blocks;
				for (let i = 0; i < blocks.length; i += 4) {
					const x = blocks[i];
					const y = blocks[i + 1];
					const z = blocks[i + 2];
					if (
						x >= renderingBounds.min.x &&
						x < renderingBounds.max.x &&
						y >= renderingBounds.min.y &&
						y < renderingBounds.max.y &&
						z >= renderingBounds.min.z &&
						z < renderingBounds.max.z
					) {
						filtered.push(x, y, z, blocks[i + 3]);
					}
				}
				blocksToProcess = new Int32Array(filtered);
			} else {
				blocksToProcess = chunkData.blocks.filter((block) => {
					const [x, y, z] = block;
					return (
						x >= renderingBounds.min.x &&
						x < renderingBounds.max.x &&
						y >= renderingBounds.min.y &&
						y < renderingBounds.max.y &&
						z >= renderingBounds.min.z &&
						z < renderingBounds.max.z
					);
				});
			}
		}

		if (blocksToProcess.length === 0) return { geometries: [], origin: [0, 0, 0] };

		const originX = chunkData.chunk_x * this.chunkSize;
		const originY = chunkData.chunk_y * this.chunkSize;
		const originZ = chunkData.chunk_z * this.chunkSize;

		// GPU Compute path
		if (this.useGPUCompute && this.computeMeshBuilder?.isReady) {
			try {
				const gpuResult = await this.computeMeshBuilder.buildChunk(
					blocksToProcess as Int32Array,
					[originX, originY, originZ],
					chunkId
				);

				if (gpuResult) {
					return {
						geometries: gpuResult.geometries,
						origin: gpuResult.origin,
					};
				}
			} catch (error) {
				console.warn("[WorldMeshBuilder] GPU compute failed, falling back to workers:", error);
				// Fall through to worker path
			}
		}

		// Worker fallback path
		const workerBlocks = blocksToProcess;

		try {
			// Ensure workers exist
			if (this.workers.length === 0) {
				this.initializeWorkers();
			}

			// Get a free worker
			const worker = await this.getFreeWorker();
			if (this.disposed) {
				this.returnWorker(worker);
				throw new Error("WorldMeshBuilder is disposed");
			}

			const workerPromise = new Promise<MeshBuildResult>((resolve, reject) => {
				// Add timeout to prevent hanging
				const timeoutId = setTimeout(() => {
					const request = this.pendingRequests.get(chunkId);
					if (!request) return;
					this.pendingRequests.delete(chunkId);
					request.reject(new Error(`Chunk build timeout for ${chunkId}`));
					this.returnWorker(request.worker);
				}, 30000); // 30 seconds timeout

				this.pendingRequests.set(chunkId, {
					resolve: (data) => {
						clearTimeout(timeoutId);
						// Clean up shared memory buffer if used
						if (this.sharedMemoryPool) {
							this.sharedMemoryPool.releaseBuffers(chunkId);
						}
						resolve(data);
					},
					reject: (err) => {
						clearTimeout(timeoutId);
						// Clean up shared memory buffer if used
						if (this.sharedMemoryPool) {
							this.sharedMemoryPool.releaseBuffers(chunkId);
						}
						reject(err);
					},
					worker: worker,
				});

				try {
					// Use SharedArrayBuffer for zero-copy transfer if available
					if (this.useSharedMemory && this.sharedMemoryPool && workerBlocks instanceof Int32Array) {
						// Write data to shared memory - worker reads directly, no copy!
						const sharedBuffer = this.sharedMemoryPool.writeChunkInput(
							chunkId,
							workerBlocks,
							originX,
							originY,
							originZ
						);

						worker.postMessage({
							type: "buildChunk",
							chunkId,
							sharedInputBuffer: sharedBuffer, // Worker reads from this directly
							chunkOrigin: [originX, originY, originZ],
							meshContextId: this.meshContextId,
						});
					} else {
						// Fallback: transfer via postMessage (copies data)
						const transferList: Transferable[] = [];
						if (workerBlocks instanceof Int32Array) {
							transferList.push(workerBlocks.buffer);
						}

						worker.postMessage(
							{
								type: "buildChunk",
								chunkId,
								blocks: workerBlocks,
								chunkOrigin: [originX, originY, originZ],
								meshContextId: this.meshContextId,
							},
							transferList
						);
					}
				} catch (error) {
					this.pendingRequests.get(chunkId)?.reject(error);
					this.pendingRequests.delete(chunkId);
					this.returnWorker(worker);
				}
			});

			const workerResult = await workerPromise;
			return {
				geometries: workerResult.meshes,
				origin: workerResult.origin || [originX, originY, originZ],
			};
		} catch (error) {
			console.error("Error building chunk geometry:", error);
			return { geometries: [], origin: [0, 0, 0] };
		}
	}

	/**
	 * Render sign block entities as standalone meshes, independent of the build mode.
	 *
	 * The `batched` and `instanced` build paths don't process block entities at all,
	 * and even the chunk path's tile-entity handling lacks the blockstate properties
	 * (facing/rotation) signs need. Signs require BOTH per-instance NBT (the text) and
	 * the blockstate (orientation), so we render them here once per schematic build and
	 * the caller adds the results to the schematic group. The greedy/palette paths emit
	 * nothing for signs (cubane returns empty when called without NBT), so there's no
	 * doubling.
	 */
	public async buildSignMeshes(
		schematicObject: SchematicObject,
		signal?: AbortSignal
	): Promise<THREE.Object3D[]> {
		const beMap = schematicObject.getBlockEntitiesMap();
		if (beMap.size === 0) return [];

		const wrapper = schematicObject.schematicWrapper;
		const out: THREE.Object3D[] = [];

		for (const entity of beMap.values()) {
			if (signal?.aborted || this.disposed) break;
			const pos = entity.position;
			if (!pos) continue;

			// Resolve the blockstate (name + facing/rotation) at this position.
			let name: string | undefined;
			const props: Record<string, string> = {};
			try {
				const bs = wrapper.get_block_with_properties(pos[0], pos[1], pos[2]);
				if (bs) {
					name = bs.name();
					const p = bs.properties();
					if (p && typeof p === "object") {
						for (const [k, v] of Object.entries(p)) props[k] = String(v);
					}
				}
			} catch {
				/* fall through */
			}
			if (!name || !name.includes("sign")) continue;

			const propStr = Object.entries(props)
				.map(([k, v]) => `${k}=${v}`)
				.join(",");
			const blockString = propStr ? `${name}[${propStr}]` : name;
			const nbt = entity.nbt || entity;

			try {
				const mesh = await this.cubane.getBlockMesh(blockString, "plains", false, nbt);
				if (!mesh) continue;
				// cubane builds block geometry centred on the integer coordinate (c/16 - 0.5),
				// so the sign (already centred [-0.5,0.5]) goes straight at the block position
				// to line up with the surrounding blocks.
				const off = mesh.position.clone();
				mesh.position.set(pos[0] + off.x, pos[1] + off.y, pos[2] + off.z);
				mesh.name = `sign_${name}_${pos[0]}_${pos[1]}_${pos[2]}`;
				out.push(mesh);
			} catch (e) {
				console.warn("[WorldMeshBuilder] sign build failed", blockString, e);
			}
		}

		return out;
	}

	public async getChunkMesh(
		chunkData: {
			blocks: Array<number[]> | Int32Array;
			chunk_x: number;
			chunk_y: number;
			chunk_z: number;
			// Neighbouring chunks' boundary blocks for cross-chunk face culling (occlusion only).
			apronBlocks?: Int32Array;
		},
		schematicObject: SchematicObject,
		renderingBounds?: {
			min: THREE.Vector3;
			max: THREE.Vector3;
			enabled?: boolean;
		},
		preFilteredEntities?: MeshBlockEntity[] // Optimization: entities already filtered by WASM
	): Promise<THREE.Object3D[]> {
		const chunkId = `${this.meshContextId}:${this.requestSequence++}:${chunkData.chunk_x},${chunkData.chunk_y},${chunkData.chunk_z}`;

		if (!this.paletteCache?.isReady) {
			throw new Error("Palette cache not ready. Call precomputePaletteGeometries() first.");
		}

		if (chunkData.blocks.length === 0) return [];

		// Filter blocks based on bounds
		let blocksToProcess = chunkData.blocks;
		// Optimization: Skip main-thread filtering if bounds are disabled or cover full chunk
		if (renderingBounds?.enabled) {
			if (chunkData.blocks instanceof Int32Array) {
				const filtered: number[] = [];
				const blocks = chunkData.blocks;
				for (let i = 0; i < blocks.length; i += 4) {
					const x = blocks[i];
					const y = blocks[i + 1];
					const z = blocks[i + 2];
					if (
						x >= renderingBounds.min.x &&
						x < renderingBounds.max.x &&
						y >= renderingBounds.min.y &&
						y < renderingBounds.max.y &&
						z >= renderingBounds.min.z &&
						z < renderingBounds.max.z
					) {
						filtered.push(x, y, z, blocks[i + 3]);
					}
				}
				blocksToProcess = new Int32Array(filtered);
			} else {
				blocksToProcess = chunkData.blocks.filter((block) => {
					const [x, y, z] = block;
					return (
						x >= renderingBounds.min.x &&
						x < renderingBounds.max.x &&
						y >= renderingBounds.min.y &&
						y < renderingBounds.max.y &&
						z >= renderingBounds.min.z &&
						z < renderingBounds.max.z
					);
				});
			}
		}

		if (blocksToProcess.length === 0) return [];

		// Identify tile entities separately - Optimized
		const tileEntityBlocks: Array<{
			x: number;
			y: number;
			z: number;
			paletteIndex: number;
			blockName: string;
			nbtData: MeshBlockEntity;
		}> = [];
		// Optimization: Pass all blocks to worker directly. Worker filters invisible blocks.
		const workerBlocks = blocksToProcess;

		// Use cached map from SchematicObject instead of fetching all entities every chunk
		// If preFilteredEntities is provided (WASM optimized path), use that directly

		if (preFilteredEntities) {
			for (const entity of preFilteredEntities) {
				// With WASM getChunkData, we get entity ID but not the full block state string.
				// However, the block at this position determines the visual appearance.
				// We need to query the block state to handle rotation/variants properly.

				// Note: entity.position from getChunkData is [x, y, z]
				const pos = entity.position; // [x, y, z]

				// Bounds checking is already done by WASM, but double check against renderingBounds if needed
				// (WASM getChunkData cuts by chunk, but renderingBounds might be tighter)
				if (renderingBounds?.enabled) {
					if (
						pos[0] < renderingBounds.min.x ||
						pos[0] >= renderingBounds.max.x ||
						pos[1] < renderingBounds.min.y ||
						pos[1] >= renderingBounds.max.y ||
						pos[2] < renderingBounds.min.z ||
						pos[2] >= renderingBounds.max.z
					) {
						continue;
					}
				}

				const blockName = schematicObject.schematicWrapper.get_block(pos[0], pos[1], pos[2]);

				if (
					// Signs are handled by the mode-independent buildSignMeshes pass.
					blockName &&
					(blockName.includes("chest") || blockName.includes("banner"))
				) {
					tileEntityBlocks.push({
						x: pos[0],
						y: pos[1],
						z: pos[2],
						paletteIndex: -1,
						blockName: blockName,
						nbtData: entity, // The entity structure from WASM is compatible enough or we use it as is
					});
				}
			}
		} else {
			// Fallback: JS-side filtering using cached spatial index
			const blockEntityMap = schematicObject.getBlockEntitiesMap();

			// Only scan for entities if map is not empty and reasonably sized
			// For very large entity maps, skip to avoid O(E*C) complexity
			if (blockEntityMap.size > 0 && blockEntityMap.size < 10000) {
				// Use spatial cache if available, otherwise build it once
				let cachesByChunkSize = this.entitySpatialCaches.get(blockEntityMap);
				if (!cachesByChunkSize) {
					cachesByChunkSize = new Map();
					this.entitySpatialCaches.set(blockEntityMap, cachesByChunkSize);
				}
				let spatialCache = cachesByChunkSize.get(this.chunkSize);

				if (!spatialCache) {
					spatialCache = new Map<string, MeshBlockEntity[]>();
					for (const [, entity] of blockEntityMap) {
						const pos = entity.position;
						const chunkKey = `${Math.floor(pos[0] / this.chunkSize)},${Math.floor(pos[1] / this.chunkSize)},${Math.floor(pos[2] / this.chunkSize)}`;
						const entities = spatialCache.get(chunkKey) ?? [];
						entities.push(entity);
						spatialCache.set(chunkKey, entities);
					}
					cachesByChunkSize.set(this.chunkSize, spatialCache);
				}

				// O(1) lookup for this chunk's entities
				const chunkKey = `${chunkData.chunk_x},${chunkData.chunk_y},${chunkData.chunk_z}`;
				const chunkEntities = spatialCache.get(chunkKey);

				if (chunkEntities && chunkEntities.length > 0) {
					for (const entity of chunkEntities) {
						const pos = entity.position;
						const blockName = schematicObject.schematicWrapper.get_block(pos[0], pos[1], pos[2]);

						if (
							// Signs are handled by the mode-independent buildSignMeshes pass.
							blockName &&
							(blockName.includes("chest") || blockName.includes("banner"))
						) {
							tileEntityBlocks.push({
								x: pos[0],
								y: pos[1],
								z: pos[2],
								paletteIndex: -1,
								blockName: blockName,
								nbtData: entity,
							});
						}
					}
				}
			}
		}

		// Determine chunk origin
		const originX = chunkData.chunk_x * this.chunkSize;
		const originY = chunkData.chunk_y * this.chunkSize;
		const originZ = chunkData.chunk_z * this.chunkSize;

		const resultMeshes: THREE.Object3D[] = [];

		// TIMING: Track operation timings
		const timings = {
			workerDispatch: 0,
			bufferGeometry: 0,
			tileEntities: 0,
		};
		let timingStart = performance.now();

		// Try GPU compute first, then fall back to workers
		let buildResult: MeshBuildResult | null = null;

		// GPU Compute path
		if (this.useGPUCompute && this.computeMeshBuilder?.isReady) {
			try {
				const gpuResult = await this.computeMeshBuilder.buildChunk(
					workerBlocks as Int32Array,
					[originX, originY, originZ],
					chunkId
				);

				if (gpuResult) {
					buildResult = {
						meshes: gpuResult.geometries,
						origin: gpuResult.origin,
					};
				}
			} catch (error) {
				console.warn("[WorldMeshBuilder] GPU compute failed, falling back to workers:", error);
				// Fall through to worker path
			}
		}

		// Worker fallback path
		if (!buildResult) {
			// Ensure workers exist
			if (this.workers.length === 0) {
				this.initializeWorkers();
			}

			// TIMING: Measure getFreeWorker wait time
			const getFreeWorkerStart = performance.now();

			// Get a free worker
			const worker = await this.getFreeWorker();
			if (this.disposed) {
				this.returnWorker(worker);
				throw new Error("WorldMeshBuilder is disposed");
			}

			const getFreeWorkerTime = performance.now() - getFreeWorkerStart;
			if (getFreeWorkerTime > 10) {
				console.warn(
					`[WorkerPool] getFreeWorker took ${getFreeWorkerTime.toFixed(0)}ms (free: ${this.freeWorkers.length}/${this.workers.length}, queue: ${this.workerQueue.length})`
				);
			}

			const workerPromise = new Promise<MeshBuildResult>((resolve, reject) => {
				// Add timeout to prevent hanging
				const timeoutId = setTimeout(() => {
					const request = this.pendingRequests.get(chunkId);
					if (!request) return;
					this.pendingRequests.delete(chunkId);
					request.reject(new Error(`Chunk build timeout for ${chunkId}`));
					this.returnWorker(request.worker);
				}, 30000); // 30 seconds timeout

				this.pendingRequests.set(chunkId, {
					resolve: (data) => {
						clearTimeout(timeoutId);
						// Clean up shared memory buffer if used
						if (this.sharedMemoryPool) {
							this.sharedMemoryPool.releaseBuffers(chunkId);
						}
						resolve(data);
					},
					reject: (err) => {
						clearTimeout(timeoutId);
						// Clean up shared memory buffer if used
						if (this.sharedMemoryPool) {
							this.sharedMemoryPool.releaseBuffers(chunkId);
						}
						reject(err);
					},
					worker: worker,
				});

				try {
					// TIMING: Record when we send the message
					const sendTime = performance.now();

					// Use SharedArrayBuffer for zero-copy transfer if available
					if (this.useSharedMemory && this.sharedMemoryPool && workerBlocks instanceof Int32Array) {
						// Write data to shared memory - worker reads directly, no copy!
						const sharedBuffer = this.sharedMemoryPool.writeChunkInput(
							chunkId,
							workerBlocks,
							originX,
							originY,
							originZ
						);

						worker.postMessage({
							type: "buildChunk",
							chunkId,
							sharedInputBuffer: sharedBuffer,
							chunkOrigin: [originX, originY, originZ],
							apronBlocks: chunkData.apronBlocks, // occlusion-only neighbour shell
							meshContextId: this.meshContextId,
							_sendTime: sendTime, // Pass timestamp for round-trip measurement
						});
					} else {
						// Fallback: transfer via postMessage (copies data)
						const transferList: Transferable[] = [];
						if (workerBlocks instanceof Int32Array) {
							transferList.push(workerBlocks.buffer);
						}

						worker.postMessage(
							{
								type: "buildChunk",
								chunkId,
								blocks: workerBlocks,
								chunkOrigin: [originX, originY, originZ],
								apronBlocks: chunkData.apronBlocks, // occlusion-only neighbour shell
								meshContextId: this.meshContextId,
							},
							transferList
						);
					}
				} catch (error) {
					this.pendingRequests.get(chunkId)?.reject(error);
					this.pendingRequests.delete(chunkId);
					this.returnWorker(worker);
				}
			});

			buildResult = await workerPromise;
		}
		timings.workerDispatch = performance.now() - timingStart;
		timingStart = performance.now();

		try {
			// Process build result (same for GPU and worker)
			const workerResult = buildResult;

			if (!workerResult) {
				console.warn("[WorldMeshBuilder] No build result available");
				return resultMeshes;
			}

			// Reconstruct meshes from worker buffers
			if (workerResult.meshes) {
				for (const meshData of workerResult.meshes) {
					const geometry = new THREE.BufferGeometry();

					// Handle quantized positions
					// Worker sends Int16Array, we load it as BufferAttribute
					if (meshData.positions) {
						// BufferAttribute(array, itemSize, normalized)
						// Int16Array with normalized=false sends raw integer values to shader, which are cast to float
						const posAttr = new THREE.BufferAttribute(meshData.positions, 3, false);
						geometry.setAttribute("position", posAttr);
					}

					if (meshData.normals) {
						// Convert Int8 normals to Float32 for WebGPU compatibility
						const float32Normals =
							meshData.normals instanceof Int8Array
								? convertInt8NormalsToFloat32(meshData.normals)
								: meshData.normals;
						const normAttr = new THREE.BufferAttribute(float32Normals, 3);
						geometry.setAttribute("normal", normAttr);
					}

					if (meshData.uvs) {
						// Float32Array for UVs to support tiling > 1.0
						const uvAttr = new THREE.BufferAttribute(meshData.uvs, 2);
						geometry.setAttribute("uv", uvAttr);
					}

					if (meshData.indices) {
						geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
					}

					// Groups
					if (meshData.groups) {
						for (const group of meshData.groups) {
							geometry.addGroup(group.start, group.count, group.materialIndex);
						}
					}

					const mesh = new THREE.Mesh(geometry, this.paletteCache.globalMaterials);
					mesh.name = `${meshData.category}_chunk`;

					// Apply de-quantization scale for position
					// 1.0 / POSITION_SCALE
					const scale = 1.0 / POSITION_SCALE;
					mesh.scale.setScalar(scale);

					// Apply chunk origin offset
					// The worker produces geometry relative to this origin
					if (workerResult.origin) {
						mesh.position.set(
							workerResult.origin[0],
							workerResult.origin[1],
							workerResult.origin[2]
						);
					}

					this.configureMeshForCategory(mesh, meshData.category as keyof ChunkMeshes);
					resultMeshes.push(mesh);
				}
			}
			timings.bufferGeometry = performance.now() - timingStart;
			timingStart = performance.now();

			// Process tile entities (Main Thread)
			if (tileEntityBlocks.length > 0) {
				// const palette = this.paletteCache.palette; // Not needed if we use blockName
				for (const tileBlock of tileEntityBlocks) {
					const { x, y, z, paletteIndex, blockName, nbtData } = tileBlock;

					// If we have direct blockName, use it. Otherwise look up via paletteIndex (legacy path)
					let blockString = "";
					if (blockName) {
						blockString = blockName;
						// Note: We might need properties. get_block returns just name?
						// get_block returns full state string "minecraft:chest[facing=north]" usually?
						// Actually nucleation get_block returns just name or state?
						// Let's assume we might need to fetch full state if get_block returns only "minecraft:chest"

						// Optimization: If needed, we can assume 'blockName' from the loop above is sufficient
						// or fetch properties if missing.
					} else if (paletteIndex >= 0) {
						const blockState = this.paletteCache.palette[paletteIndex];
						blockString = this.createBlockStringFromPaletteEntry(blockState);
					}

					if (blockString && !this.blockEntityRenderers.handles(blockString.split("[", 1)[0])) {
						try {
							// const blockString = this.createBlockStringFromPaletteEntry(blockState);
							const customMesh = await this.cubane.getBlockMesh(
								blockString,
								"plains",
								false,
								nbtData.nbt || nbtData
							);
							if (customMesh) {
								const currentOffset = customMesh.position.clone();
								customMesh.position.set(
									x + currentOffset.x,
									y + currentOffset.y,
									z + currentOffset.z
								);
								customMesh.name = `tile_entity_${blockString}_${x}_${y}_${z}`;
								resultMeshes.push(customMesh);
							}
						} catch (e) {
							console.warn("Tile entity error", e);
						}
					}
				}
			}
			timings.tileEntities = performance.now() - timingStart;
		} catch (error) {
			console.error("Error building chunk mesh:", error);
		}

		// Log detailed timing every 10 chunks
		if (!this._timingStats) {
			this._timingStats = {
				count: 0,
				worker: 0,
				buffer: 0,
				tile: 0,
				maxWorker: 0,
				maxBuffer: 0,
				maxTile: 0,
			};
		}
		this._timingStats.count++;
		this._timingStats.worker += timings.workerDispatch;
		this._timingStats.buffer += timings.bufferGeometry;
		this._timingStats.tile += timings.tileEntities;
		this._timingStats.maxWorker = Math.max(this._timingStats.maxWorker, timings.workerDispatch);
		this._timingStats.maxBuffer = Math.max(this._timingStats.maxBuffer, timings.bufferGeometry);
		this._timingStats.maxTile = Math.max(this._timingStats.maxTile, timings.tileEntities);

		if (this._timingStats.count % 10 === 0) {
			const n = this._timingStats.count;
			console.log(
				`[ChunkTiming n=${n}] avg: worker=${(this._timingStats.worker / n).toFixed(1)}ms, buffer=${(this._timingStats.buffer / n).toFixed(1)}ms, tile=${(this._timingStats.tile / n).toFixed(1)}ms | max: w=${this._timingStats.maxWorker.toFixed(0)}, b=${this._timingStats.maxBuffer.toFixed(0)}, t=${this._timingStats.maxTile.toFixed(0)}`
			);
		}

		return resultMeshes;
	}

	// Helper methods...
	private createBlockStringFromPaletteEntry(blockState: PaletteCache["palette"][number]): string {
		let blockString = blockState.name || "minecraft:stone";
		if (!blockString.includes(":")) blockString = `minecraft:${blockString}`;

		if (blockState.properties && Object.keys(blockState.properties).length > 0) {
			const props = Object.entries(blockState.properties)
				.map(([k, v]) => `${k}=${v}`)
				.join(",");
			blockString += `[${props}]`;
		}
		return blockString;
	}

	// Blocks that hold water without ever exposing a `waterlogged` property. Mirrors
	// BlockMeshBuilder.ALWAYS_WATERLOGGED so their generated water joins the water pass.
	private static readonly IMPLICIT_WATERLOGGED = new Set<string>([
		"minecraft:kelp",
		"minecraft:kelp_plant",
		"minecraft:seagrass",
		"minecraft:tall_seagrass",
		"minecraft:bubble_column",
	]);

	private getBlockCategory(
		blockName: string,
		properties?: Record<string, string>
	): keyof ChunkMeshes {
		if (blockName.includes("water") || blockName.includes("lava")) return "water";
		// Waterlogged blocks carry a surrounding water cube that must cull against
		// neighbouring water (real water or other waterlogged cells), so they render
		// in the water category. Their own geometry is unaffected: cross/non-flush
		// faces never cull, and solid faces simply draw in the water pass.
		if (
			properties?.waterlogged === "true" ||
			WorldMeshBuilder.IMPLICIT_WATERLOGGED.has(blockName)
		) {
			return "water";
		}
		if (
			blockName.includes("glass") ||
			blockName.includes("leaves") ||
			blockName.includes("ice") ||
			blockName === "minecraft:barrier"
		)
			return "transparent";
		return "solid";
	}

	private configureMeshForCategory(mesh: THREE.Mesh, category: keyof ChunkMeshes): void {
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		mesh.frustumCulled = true;

		// Optimization: Material properties are now handled in precomputePaletteGeometries via MaterialRegistry keys.
		// We only set mesh-level properties here.
		switch (category) {
			case "water":
				mesh.renderOrder = 3;
				break;
			case "transparent":
				mesh.renderOrder = 2;
				break;
			case "emissive":
				mesh.renderOrder = 1;
				break;
			case "redstone":
				mesh.userData.isDynamic = true;
				break;
		}
	}

	private extractAllMeshData(rootCubaneObject: THREE.Object3D): ProcessedBlockGeometry[] {
		const allMeshData: ProcessedBlockGeometry[] = [];
		rootCubaneObject.updateMatrixWorld(true);

		rootCubaneObject.traverse((child) => {
			if (
				child instanceof THREE.Mesh &&
				child.geometry &&
				child.material &&
				child.visible &&
				child !== rootCubaneObject
			) {
				const material = Array.isArray(child.material) ? child.material[0] : child.material;
				if (!material || !(material instanceof THREE.Material)) return;

				const geometry = child.geometry.clone();
				const matrixRelativeToRoot = child.matrixWorld
					.clone()
					.multiply(new THREE.Matrix4().copy(rootCubaneObject.matrixWorld).invert());
				geometry.applyMatrix4(matrixRelativeToRoot);

				if (geometry.attributes.position.count > 0) {
					allMeshData.push({ geometry, material });
				} else {
					geometry.dispose();
				}
			}
		});
		return allMeshData;
	}

	private createFallbackObject3D(blockString: string): THREE.Object3D {
		const mesh = new THREE.Mesh(
			new THREE.BoxGeometry(0.7, 0.7, 0.7),
			new THREE.MeshBasicMaterial({
				color: 0xee00ee,
				wireframe: true,
				name: `fallback-mat-${blockString}`,
			})
		);
		mesh.name = `fallback-mesh-${blockString}`;
		const group = new THREE.Group();
		group.add(mesh);
		group.name = `fallback-object-${blockString}`;
		return group;
	}

	public getPaletteStats() {
		return {
			isReady: this.paletteCache?.isReady || false,
			paletteSize: this.paletteCache?.blockData.length || 0,
			uniqueMaterials: this.paletteCache?.globalMaterials.length || 0,
			memoryEstimate:
				this.paletteCache?.blockData.reduce((total, blockData) => {
					return (
						total +
						blockData.materialGroups.reduce((subtotal, group) => {
							return subtotal + (group.baseGeometry.attributes.position?.count || 0) * 3 * 4;
						}, 0)
					);
				}, 0) || 0,
		};
	}

	public enableInstancedRendering(group: THREE.Group, merged: boolean = false): void {
		if (!this.paletteCache) throw new Error("Palette cache not ready for instanced rendering");
		this.useInstancedRendering = true;
		this.instancedRenderer = new InstancedBlockRenderer(group, this.paletteCache);

		if (merged) {
			this.instancedRenderer.initializeInstancedMeshesMerged();
		} else {
			this.instancedRenderer.initializeInstancedMeshes();
		}
	}

	public disableInstancedRendering(): void {
		this.useInstancedRendering = false;
		if (this.instancedRenderer) {
			this.instancedRenderer.disposeInstancedMeshes();
			this.instancedRenderer = null;
		}
	}

	public async renderSchematicInstanced(schematicObject: SchematicObject): Promise<void> {
		if (!this.useInstancedRendering || !this.instancedRenderer) {
			throw new Error("Instanced rendering not enabled. Call enableInstancedRendering() first.");
		}

		const schematic = schematicObject.schematicWrapper;

		const allBlockIndices = schematic.blocks_indices();

		const allBlocks: Array<{
			x: number;
			y: number;
			z: number;
			paletteIndex: number;
		}> = [];

		for (const blockData of allBlockIndices) {
			const [x, y, z, paletteIndex] = blockData;

			const renderingBounds = schematicObject.renderingBounds;
			if (renderingBounds?.enabled) {
				if (
					x < renderingBounds.min.x ||
					x >= renderingBounds.max.x ||
					y < renderingBounds.min.y ||
					y >= renderingBounds.max.y ||
					z < renderingBounds.min.z ||
					z >= renderingBounds.max.z
				) {
					continue;
				}
			}

			allBlocks.push({ x, y, z, paletteIndex });
		}

		this.instancedRenderer.renderBlocksInstanced(allBlocks);
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const error = new Error("WorldMeshBuilder is disposed");
		for (const [queued, reject] of this.queuedWorkerRequests) {
			const index = this.workerQueue.indexOf(queued);
			if (index >= 0) this.workerQueue.splice(index, 1);
			reject(error);
		}
		this.queuedWorkerRequests.clear();
		this.batchRequests.forEach((request) => request.reject(error));
		this.batchRequests.clear();
		if (!this.ownsWorkerPool) {
			for (const worker of this.workers)
				worker.postMessage({ type: "disposeContext", meshContextId: this.meshContextId });
		}
		for (const worker of this.borrowedWorkers) this.returnWorker(worker);
		// Reject any pending requests before destroying workers
		this.pendingRequests.forEach((request, chunkId) => {
			request.reject(new Error(`Worker terminated before processing chunk ${chunkId}`));
		});
		this.pendingRequests.clear();

		// Clear worker queue
		this.workerQueue = [];

		for (const geometry of this.paletteGeometries) geometry.dispose();
		this.paletteGeometries.clear();
		this.paletteCache = null;

		this.instancedRenderer?.disposeInstancedMeshes();
		this.instancedRenderer = null;

		// Dispose GPU compute resources
		if (this.computeMeshBuilder) {
			this.computeMeshBuilder.dispose();
			this.computeMeshBuilder = null;
		}
		this.useGPUCompute = false;
		this.gpuInitPromise = null;

		// Terminate workers only if we own them. A shared-context pool is owned by
		// the context (and terminated when it disposes), so a context-backed builder
		// must not terminate workers still used by sibling renderers.
		if (this.ownsWorkerPool) {
			this.workers.forEach((w) => w.terminate());
		}
		this.workers = [];
		this.freeWorkers = [];
		for (const [material, count] of this.materialReferences) {
			for (let i = 0; i < count; i++) MaterialRegistry.releaseMaterial(material);
		}
		this.materialReferences.clear();
		// Weak ownership markers cover meshes completing after disposal without retaining materials.

		console.log("[WorldMeshBuilder] Disposed palette cache, GPU compute, and workers.");
		console.log("[WorldMeshBuilder] dispose() called from:", new Error().stack);
	}
}
