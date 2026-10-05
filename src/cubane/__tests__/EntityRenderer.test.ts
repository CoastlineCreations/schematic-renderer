import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { EntityRenderer } from "../EntityRenderer";
import { entityModelLoaders } from "../entity-models";

afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((complete) => (resolve = complete));
	return { promise, resolve };
}

function fixture() {
	const texture = new THREE.Texture();
	const material = new THREE.MeshStandardMaterial({ map: texture, emissiveMap: texture });
	const geometry = new THREE.BoxGeometry();
	const scene = new THREE.Group();
	scene.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, [material]));
	const gltf = { scene } as GLTF;
	const parse = vi.spyOn(GLTFLoader.prototype, "parseAsync").mockResolvedValue(gltf);
	const pig = vi.fn().mockResolvedValue({ default: btoa("pig model") });
	const rabbit = vi.fn().mockResolvedValue({ default: btoa("rabbit model") });
	const renderer = new EntityRenderer({ pig, rabbit });
	return { renderer, pig, rabbit, parse, scene, gltf, geometry, material, texture };
}

describe("lazy entity models", () => {
	it("loads only the selected model, then reuses it with independent scene transforms", async () => {
		const { renderer, pig, rabbit, parse } = fixture();
		expect(pig).not.toHaveBeenCalled();
		expect(rabbit).not.toHaveBeenCalled();

		const first = await renderer.createEntityMesh("pig");
		const second = await renderer.createEntityMesh("pig");
		expect(pig).toHaveBeenCalledOnce();
		expect(rabbit).not.toHaveBeenCalled();
		expect(parse).toHaveBeenCalledOnce();
		const parsedBytes = parse.mock.calls[0][0] as ArrayBuffer;
		expect(new TextDecoder().decode(parsedBytes)).toBe("pig model");
		expect(first).toBeInstanceOf(THREE.Group);
		expect(second).not.toBe(first);
		expect(second?.children[0]).not.toBe(first?.children[0]);
		expect(first?.children[0].position.y).toBe(-0.5);
		first?.children[0].position.setY(4);
		expect(second?.children[0].position.y).toBe(-0.5);
		renderer.dispose();
	});

	it("deduplicates concurrent loads and preloads before parsing completes", async () => {
		const { renderer, pig, rabbit, parse, gltf } = fixture();
		const parsing = deferred<GLTF>();
		parse.mockReturnValue(parsing.promise);
		const first = renderer.createEntityMesh("pig");
		const second = renderer.createEntityMesh("pig");
		const preload = renderer.preloadModels(["pig", "pig"]);
		await Promise.resolve();
		expect(pig).toHaveBeenCalledOnce();
		expect(parse).toHaveBeenCalledOnce();
		expect(rabbit).not.toHaveBeenCalled();
		parsing.resolve(gltf);
		const [firstMesh, secondMesh] = await Promise.all([first, second, preload]);
		expect(firstMesh).toBeInstanceOf(THREE.Group);
		expect(secondMesh).not.toBe(firstMesh);
		renderer.dispose();
	});

	it.each(["import", "parse"])("allows retry after a failed %s", async (stage) => {
		const { renderer, pig, parse } = fixture();
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const error = new Error("temporary failure");
		if (stage === "import") pig.mockRejectedValueOnce(error);
		else parse.mockRejectedValueOnce(error);
		expect(await renderer.createEntityMesh("pig")).toBeNull();
		expect(errorLog).toHaveBeenCalledOnce();
		expect(await renderer.createEntityMesh("pig")).toBeInstanceOf(THREE.Group);
		expect(pig).toHaveBeenCalledTimes(2);
		renderer.dispose();
	});

	it("rejects missing models and inherited property names without invoking a loader", async () => {
		const { renderer, pig, rabbit, parse } = fixture();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(await renderer.createEntityMesh("missing")).toBeNull();
		expect(await renderer.createEntityMesh("toString")).toBeNull();
		expect(pig).not.toHaveBeenCalled();
		expect(rabbit).not.toHaveBeenCalled();
		expect(parse).not.toHaveBeenCalled();
		renderer.dispose();
	});

	it("does not start parsing if disposed while downloading the model", async () => {
		const { renderer, pig, parse } = fixture();
		const downloading = deferred<{ default: string }>();
		pig.mockReturnValue(downloading.promise);
		const pending = renderer.createEntityMesh("pig");
		renderer.dispose();
		downloading.resolve({ default: btoa("pig model") });
		expect(await pending).toBeNull();
		expect(parse).not.toHaveBeenCalled();
		expect(await renderer.createEntityMesh("pig")).toBeNull();
		expect(pig).toHaveBeenCalledOnce();
	});

	it("disposes resources arriving after teardown and does not resurrect the cache", async () => {
		const { renderer, pig, parse, gltf, geometry, material, texture } = fixture();
		const parsing = deferred<GLTF>();
		parse.mockReturnValue(parsing.promise);
		const disposals = [geometry, material, texture].map((resource) =>
			vi.spyOn(resource, "dispose")
		);
		const pending = renderer.createEntityMesh("pig");
		await Promise.resolve();
		expect(parse).toHaveBeenCalledOnce();
		renderer.dispose();
		parsing.resolve(gltf);
		expect(await pending).toBeNull();
		for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce();
		expect(await renderer.createEntityMesh("pig")).toBeNull();
		expect(pig).toHaveBeenCalledOnce();
	});

	it("disposes each cached geometry, material and shared texture exactly once", async () => {
		const { renderer, geometry, material, texture } = fixture();
		const disposals = [geometry, material, texture].map((resource) =>
			vi.spyOn(resource, "dispose")
		);
		await renderer.createEntityMesh("pig");
		expect(texture.colorSpace).toBe(THREE.LinearSRGBColorSpace);
		renderer.dispose();
		renderer.dispose();
		for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce();
	});

	it("clones skinned models with independent bones and skeletons", async () => {
		const { renderer, scene } = fixture();
		const bone = new THREE.Bone();
		const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
		mesh.add(bone);
		mesh.bind(new THREE.Skeleton([bone]));
		mesh.name = "rig";
		scene.add(mesh);
		const first = (await renderer.createEntityMesh("pig"))?.getObjectByName(
			"rig"
		) as THREE.SkinnedMesh;
		const second = (await renderer.createEntityMesh("pig"))?.getObjectByName(
			"rig"
		) as THREE.SkinnedMesh;
		expect(first.skeleton).not.toBe(second.skeleton);
		expect(first.skeleton.bones[0]).not.toBe(second.skeleton.bones[0]);
		first.skeleton.bones[0].position.x = 5;
		expect(second.skeleton.bones[0].position.x).toBe(0);
		renderer.dispose();
	});

	it("retains all 369 model names and imports a valid standalone GLB payload", async () => {
		expect(Object.keys(entityModelLoaders)).toHaveLength(369);
		expect(entityModelLoaders["pig_baby_21.4"]).toBeTypeOf("function");
		const { default: payload } = await entityModelLoaders.acacia_boat_patch();
		const binary = atob(payload);
		expect(binary.slice(0, 4)).toBe("glTF");
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		const header = new DataView(bytes.buffer);
		expect(header.getUint32(4, true)).toBe(2);
		expect(header.getUint32(8, true)).toBe(bytes.byteLength);
	});
});
