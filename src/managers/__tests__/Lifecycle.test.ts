import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { EventEmitter } from "events";
import { RenderManager } from "../RenderManager";
import { SchematicObject } from "../SchematicObject";
import type { SchematicRenderer } from "../../SchematicRenderer";
import type { SchematicWrapper } from "../../nucleationExports";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function rendererFixture() {
	const cameraManager = new EventEmitter();
	const scene = new THREE.Scene();
	const builder = {
		ownsMaterial: vi.fn(() => false),
		ownsGeometry: vi.fn(() => false),
		buildSignMeshes: vi.fn().mockResolvedValue([]),
	};
	const fixture = {
		canvas: document.createElement("canvas"),
		options: { enableProgressBar: false, hdri: "" },
		cameraManager,
		eventEmitter: new EventEmitter(),
		worldMeshBuilder: builder,
		invalidate: vi.fn(),
	};
	const renderer = fixture as unknown as SchematicRenderer;
	renderer.sceneManager = {
		scene,
		add: (object: THREE.Object3D) => scene.add(object),
		schematicRenderer: renderer,
	} as unknown as SchematicRenderer["sceneManager"];
	return { renderer, builder, scene, cameraManager };
}

function schematicFixture() {
	const fixture = rendererFixture();
	const wrapper = {
		get_dimensions: () => [16, 16, 16],
		get_tight_dimensions: () => [16, 16, 16],
	} as unknown as SchematicWrapper;
	const schematic = new SchematicObject(fixture.renderer, "test", wrapper, { visible: false });
	return { ...fixture, schematic };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("renderer lifecycle", () => {
	it("disposes a render manager before GPU initialization, idempotently", () => {
		const { renderer } = rendererFixture();
		const manager = new RenderManager(renderer);
		expect(() => {
			manager.dispose();
			manager.dispose();
		}).not.toThrow();
	});

	it("removes resize and camera listeners and cancels queued resize work", async () => {
		vi.useFakeTimers();
		const { renderer, cameraManager } = rendererFixture();
		const manager = new RenderManager(renderer);
		const gpuDispose = vi.fn();
		Reflect.set(manager, "initWebGLRenderer", async () => {
			manager.renderer = {
				domElement: renderer.canvas,
				dispose: gpuDispose,
			} as unknown as RenderManager["renderer"];
		});
		const updateSize = vi.spyOn(manager, "updateCanvasSize").mockImplementation(() => {});
		await manager.initialize();
		expect(cameraManager.listenerCount("cameraChanged")).toBe(1);
		window.dispatchEvent(new Event("resize"));
		manager.dispose();
		manager.dispose();
		await vi.runAllTimersAsync();
		window.dispatchEvent(new Event("resize"));
		await vi.runAllTimersAsync();
		expect(updateSize).toHaveBeenCalledOnce();
		expect(cameraManager.listenerCount("cameraChanged")).toBe(0);
		expect(gpuDispose).toHaveBeenCalledOnce();
	});

	it("does not attach listeners after initialization completes on a disposed manager", async () => {
		const { renderer, cameraManager } = rendererFixture();
		const manager = new RenderManager(renderer);
		const initialization = deferred<void>();
		const gpuDispose = vi.fn();
		Reflect.set(manager, "initWebGLRenderer", () => {
			manager.renderer = {
				domElement: renderer.canvas,
				dispose: gpuDispose,
			} as unknown as RenderManager["renderer"];
			return initialization.promise;
		});
		const ready = manager.initialize();
		manager.dispose();
		initialization.resolve();
		await ready;
		expect(cameraManager.listenerCount("cameraChanged")).toBe(0);
		expect(gpuDispose).toHaveBeenCalledOnce();
	});

	it("does not dispose a context-owned WebGL renderer", () => {
		const { renderer } = rendererFixture();
		const manager = new RenderManager(renderer);
		const gpuDispose = vi.fn();
		manager.renderer = {
			domElement: renderer.canvas,
			dispose: gpuDispose,
		} as unknown as RenderManager["renderer"];
		Reflect.set(manager, "usesSharedRenderer", true);
		manager.dispose();
		expect(gpuDispose).not.toHaveBeenCalled();
	});
});

describe("schematic lifecycle", () => {
	it("stops property watchers and preserves pipeline materials on disposal", async () => {
		vi.useFakeTimers();
		const { schematic, builder, scene } = schematicFixture();
		const geometry = new THREE.BoxGeometry();
		const material = new THREE.MeshBasicMaterial();
		builder.ownsMaterial.mockReturnValue(true);
		const geometryDispose = vi.spyOn(geometry, "dispose");
		const materialDispose = vi.spyOn(material, "dispose");
		schematic.group.add(new THREE.Mesh(geometry, material));
		const propertyChanged = vi.fn();
		schematic.on("propertyChanged", propertyChanged);
		schematic.dispose();
		schematic.dispose();
		schematic.position.x++;
		await vi.advanceTimersByTimeAsync(1000);
		expect(vi.getTimerCount()).toBe(0);
		expect(propertyChanged).not.toHaveBeenCalled();
		expect(geometryDispose).toHaveBeenCalledOnce();
		expect(materialDispose).not.toHaveBeenCalled();
		expect(scene.children).not.toContain(schematic.group);
	});

	it("discards a mesh that finishes after disposal", async () => {
		const { schematic, builder } = schematicFixture();
		const geometry = new THREE.BoxGeometry();
		const material = new THREE.MeshBasicMaterial();
		const geometryDispose = vi.spyOn(geometry, "dispose");
		const materialDispose = vi.spyOn(material, "dispose");
		const pending = deferred<{ meshes: THREE.Mesh[]; chunkMap: Map<string, THREE.Object3D[]> }>();
		vi.spyOn(schematic, "buildSchematicMeshes").mockReturnValue(pending.promise);
		schematic.visible = true;
		const ready = schematic.rebuildMesh();
		await vi.waitFor(() => expect(schematic.buildSchematicMeshes).toHaveBeenCalledOnce());
		schematic.dispose();
		pending.resolve({ meshes: [new THREE.Mesh(geometry, material)], chunkMap: new Map() });
		await ready;
		expect(schematic.group.children).toHaveLength(0);
		expect(geometryDispose).toHaveBeenCalledOnce();
		expect(materialDispose).toHaveBeenCalledOnce();
		expect(builder.buildSignMeshes).not.toHaveBeenCalled();
	});
});

describe("schematic rebuild scheduling", () => {
	it("coalesces requests in one turn into one build and one completion promise", async () => {
		const { schematic } = schematicFixture();
		const build = vi
			.spyOn(schematic, "buildSchematicMeshes")
			.mockResolvedValue({ meshes: [], chunkMap: new Map() });
		schematic.visible = true;
		const first = schematic.rebuildMesh();
		const second = schematic.rebuildMesh();
		const third = schematic.rebuildMesh();
		expect(first).toBe(second);
		expect(second).toBe(third);
		await Promise.all([first, second, third]);
		expect(build).toHaveBeenCalledOnce();
		schematic.dispose();
	});

	it("drains the obsolete build before starting only the latest requested replacement", async () => {
		const { schematic } = schematicFixture();
		const pending = deferred<{ meshes: THREE.Mesh[]; chunkMap: Map<string, THREE.Object3D[]> }>();
		const oldMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		const disposed = vi.spyOn(oldMesh.geometry, "dispose");
		const latestMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		const build = vi
			.spyOn(schematic, "buildSchematicMeshes")
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValue({ meshes: [latestMesh], chunkMap: new Map() });
		schematic.visible = true;
		const completed = schematic.rebuildMesh();
		await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());
		const controller = Reflect.get(schematic, "buildController") as AbortController;
		for (let i = 0; i < 10; i++) expect(schematic.rebuildMesh()).toBe(completed);
		expect(controller.signal.aborted).toBe(true);
		expect(build).toHaveBeenCalledOnce();
		pending.resolve({ meshes: [oldMesh], chunkMap: new Map() });
		await completed;
		expect(build).toHaveBeenCalledTimes(2);
		expect(disposed).toHaveBeenCalledOnce();
		expect(schematic.group.children).toEqual([latestMesh]);
		expect(await schematic.getMeshes()).toEqual([latestMesh]);
		schematic.dispose();
	});

	it("keeps shared-builder palettes stable until the preceding object finishes", async () => {
		const { schematic, renderer } = schematicFixture();
		const other = new SchematicObject(renderer, "other", schematic.schematicWrapper, {
			visible: false,
		});
		const pending = deferred<{ meshes: THREE.Mesh[]; chunkMap: Map<string, THREE.Object3D[]> }>();
		const firstBuild = vi.spyOn(schematic, "buildSchematicMeshes").mockReturnValue(pending.promise);
		const secondBuild = vi
			.spyOn(other, "buildSchematicMeshes")
			.mockResolvedValue({ meshes: [], chunkMap: new Map() });
		schematic.visible = true;
		other.visible = true;
		const first = schematic.rebuildMesh();
		const second = other.rebuildMesh();
		await vi.waitFor(() => expect(firstBuild).toHaveBeenCalledOnce());
		expect(secondBuild).not.toHaveBeenCalled();
		pending.resolve({ meshes: [], chunkMap: new Map() });
		await Promise.all([first, second]);
		expect(secondBuild).toHaveBeenCalledOnce();
		schematic.dispose();
		other.dispose();
	});
});

describe("native block-entity registry lifecycle", () => {
	it("loads overlays through SchematicObject and replaces them on rebuild", async () => {
		const { renderer, builder } = rendererFixture();
		const overlays: { mesh: THREE.Mesh; dispose: ReturnType<typeof vi.fn>; signal: AbortSignal }[] =
			[];
		renderer.options.blockEntityOptions = {
			includeDefaultRenderers: false,
			renderers: [
				{
					id: "example:custom",
					supportsBlock: () => true,
					async render({ schematic, signal }) {
						const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
						schematic.group.add(mesh);
						const dispose = vi.fn(() => {
							mesh.removeFromParent();
							mesh.geometry.dispose();
							(mesh.material as THREE.Material).dispose();
						});
						overlays.push({ mesh, dispose, signal });
						return { count: 1, dispose };
					},
				},
			],
		};
		vi.spyOn(SchematicObject.prototype, "buildSchematicMeshes").mockResolvedValue({
			meshes: [],
			chunkMap: new Map(),
		});
		const wrapper = {
			get_dimensions: () => [4, 4, 4],
			get_tight_dimensions: () => [4, 4, 4],
		} as unknown as SchematicWrapper;
		const schematic = new SchematicObject(renderer, "overlay", wrapper);
		await schematic.getMeshes();
		expect(builder.buildSignMeshes).toHaveBeenCalledOnce();
		expect(schematic.group.children).toEqual([overlays[0].mesh]);
		await schematic.rebuildMesh();
		expect(overlays[0].signal.aborted).toBe(true);
		expect(overlays[0].dispose).toHaveBeenCalledOnce();
		expect(schematic.group.children).toEqual([overlays[1].mesh]);
		schematic.dispose();
		expect(overlays[1].signal.aborted).toBe(true);
		expect(overlays[1].dispose).toHaveBeenCalledOnce();
	});

	it("aborts a pending registry renderer and disposes its late result", async () => {
		const { schematic, renderer } = schematicFixture();
		const started = deferred<AbortSignal>();
		const completed = deferred<void>();
		const overlayDispose = vi.fn();
		renderer.options.blockEntityOptions = {
			includeDefaultRenderers: false,
			renderers: [
				{
					id: "example:slow",
					supportsBlock: () => true,
					async render({ signal }) {
						started.resolve(signal);
						await completed.promise;
						return { count: 1, dispose: overlayDispose };
					},
				},
			],
		};
		vi.spyOn(schematic, "buildSchematicMeshes").mockResolvedValue({
			meshes: [],
			chunkMap: new Map(),
		});
		schematic.visible = true;
		const rebuilt = schematic.rebuildMesh();
		const signal = await started.promise;
		schematic.dispose();
		await rebuilt;
		expect(signal.aborted).toBe(true);
		expect(overlayDispose).not.toHaveBeenCalled();
		completed.resolve();
		await vi.waitFor(() => expect(overlayDispose).toHaveBeenCalledOnce());
		expect(schematic.group.children).toHaveLength(0);
	});

	it("discards an older mesh rebuild without replacing the newer overlay", async () => {
		const { schematic, renderer } = schematicFixture();
		const pending = deferred<{ meshes: THREE.Mesh[]; chunkMap: Map<string, THREE.Object3D[]> }>();
		const overlayDispose = vi.fn();
		const render = vi.fn(async () => ({ count: 1, dispose: overlayDispose }));
		renderer.options.blockEntityOptions = {
			includeDefaultRenderers: false,
			renderers: [{ id: "example:custom", supportsBlock: () => true, render }],
		};
		const oldMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		const oldDispose = vi.spyOn(oldMesh.geometry, "dispose");
		vi.spyOn(schematic, "buildSchematicMeshes")
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValue({ meshes: [], chunkMap: new Map() });
		schematic.visible = true;
		const oldBuild = schematic.rebuildMesh();
		await vi.waitFor(() => expect(schematic.buildSchematicMeshes).toHaveBeenCalledOnce());
		const newBuild = schematic.rebuildMesh();
		pending.resolve({ meshes: [oldMesh], chunkMap: new Map() });
		await Promise.all([oldBuild, newBuild]);
		expect(oldDispose).toHaveBeenCalledOnce();
		expect(schematic.group.children).not.toContain(oldMesh);
		expect(render).toHaveBeenCalledOnce();
		expect(overlayDispose).not.toHaveBeenCalled();
		schematic.dispose();
		expect(overlayDispose).toHaveBeenCalledOnce();
	});
});

describe("block-entity NBT edits", () => {
	it("refreshes cached dimensions and entity data while preserving explicit rebuild semantics", async () => {
		const { renderer } = rendererFixture();
		let changed = false;
		const wrapper = {
			get_dimensions: () => (changed ? [17, 16, 16] : [16, 16, 16]),
			get_tight_dimensions: () => [16, 16, 16],
			get_all_block_entities: () => [
				{ position: [1, 2, 3], nbt: { value: changed ? "new" : "old" } },
			],
			setBlockWithNbt: vi.fn(() => {
				changed = true;
			}),
		};
		const schematic = new SchematicObject(
			renderer,
			"nbt-edit",
			wrapper as unknown as SchematicWrapper,
			{ visible: false }
		);
		const build = vi.spyOn(schematic, "rebuildMesh");
		expect(schematic.getDimensions()).toEqual([16, 16, 16]);
		expect(schematic.getBlockEntitiesMap().get("1,2,3")).toMatchObject({ nbt: { value: "old" } });
		await schematic.setBlockWithNbt([1, 2, 3], "minecraft:player_head", { value: "new" });
		expect(schematic.getDimensions()).toEqual([17, 16, 16]);
		expect(schematic.getBlockEntitiesMap().get("1,2,3")).toMatchObject({ nbt: { value: "new" } });
		expect(build).not.toHaveBeenCalled();
		schematic.dispose();
	});
});

describe("chunk rebuild bounds", () => {
	it("rebuilds chunks beyond disabled bounds and removes them only when slicing is enabled", async () => {
		const { schematic, builder } = schematicFixture();
		const chunk = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		const disposed = vi.spyOn(chunk.geometry, "dispose");
		const build = vi.fn().mockResolvedValue([chunk]);
		Reflect.set(builder, "getChunkMesh", build);
		Reflect.set(schematic.schematicWrapper, "get_chunk_blocks_indices", () => [[16, 0, 0, 0]]);
		await schematic.rebuildChunk(1, 0, 0);
		expect(build).toHaveBeenCalledOnce();
		expect(schematic.group.children).toContain(chunk);
		expect(schematic.getChunkObjectsAt(1, 0, 0)).toEqual([chunk]);
		schematic.renderingBounds.enabled = true;
		await schematic.rebuildChunk(1, 0, 0);
		expect(build).toHaveBeenCalledOnce();
		expect(schematic.getChunkObjectsAt(1, 0, 0)).toBeNull();
		expect(schematic.group.children).not.toContain(chunk);
		expect(disposed).toHaveBeenCalledOnce();
		schematic.dispose();
	});
});
