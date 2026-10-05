import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { AssetLoader } from "../AssetLoader";
import { BlockMeshBuilder } from "../BlockMeshBuilder";
import { Cubane } from "../Cubane";
import { ModelResolver } from "../ModelResolver";
import { TintManager } from "../TintManager";
import { getBlockOcclusionFlags } from "../../utils/occlusion";
import type { BlockModel, BlockModelElement, FaceDirection } from "../types";

afterEach(() => vi.restoreAllMocks());

function fixtureBuilder() {
	const loader = new AssetLoader(false);
	const baseMaterial = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
	vi.spyOn(loader, "getMaterial").mockResolvedValue(baseMaterial);
	return { loader, builder: new BlockMeshBuilder(loader), baseMaterial };
}

function meshes(
	object: THREE.Object3D
): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[] {
	const result: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[] = [];
	object.traverse((child) => {
		if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial)
			result.push(child);
	});
	return result;
}

function modelWithFace(direction: FaceDirection): BlockModel {
	return {
		elements: [
			{ from: [2, 4, 6], to: [10, 12, 14], faces: { [direction]: { texture: "block/stone" } } },
		],
	};
}

describe("resource-pack model semantics", () => {
	it("loads cauldron models unchanged instead of synthesizing a fluid cube", async () => {
		const loader = new AssetLoader(false);
		const cauldron = modelWithFace("up");
		vi.spyOn(loader, "getResourceString").mockResolvedValue(JSON.stringify(cauldron));
		expect(await loader.getModel("minecraft:block/water_cauldron_level3")).toEqual(cauldron);
		expect(await loader.getModel("block/lava_cauldron")).toEqual(cauldron);
		const water = await loader.getModel("block/water_level_2");
		expect(water.elements?.[0].to[1]).toBeLessThan(16);
		expect(water.textures?.all).toBe("block/water_still");
	});

	it("resolves bare and prefixed symbolic textures and terminates cycles", () => {
		const loader = new AssetLoader(false);
		const model = {
			textures: { content: "#water", water: "minecraft:block/water_still", loop: "#loop" },
		};
		expect(loader.resolveTexture("content", model)).toBe("block/water_still");
		expect(loader.resolveTexture("#content", model)).toBe("block/water_still");
		expect(loader.resolveTexture("loop", model)).toBe("block/missing_texture");
		expect(loader.resolveTexture("#absent", model)).toBe("block/missing_texture");
		expect(
			loader.resolveTexture("#all", {
				textures: { all: { sprite: "minecraft:block/stone", atlas: "minecraft:blocks" } },
			})
		).toBe("block/stone");
		expect(loader.resolveTexture({ sprite: "minecraft:block/stone" }, {})).toBe("block/stone");
	});

	it("selects multipart models through nested AND/OR and pipe values", async () => {
		const loader = new AssetLoader(false);
		vi.spyOn(loader, "getBlockState").mockResolvedValue({
			multipart: [
				{
					when: {
						AND: [{ facing: "north|south" }, { OR: [{ open: "true" }, { powered: "true" }] }],
					},
					apply: { model: "block/panel" },
				},
			],
		});
		const resolver = new ModelResolver(loader);
		const block = {
			namespace: "minecraft",
			name: "panel",
			properties: { facing: "south", open: "false", powered: "true" },
		};
		expect(await resolver.resolveBlockModel(block)).toHaveLength(1);
		expect(
			await resolver.resolveBlockModel({
				...block,
				properties: { ...block.properties, facing: "east" },
			})
		).toEqual([]);
		expect(await resolver.resolveBlockModel({ ...block, properties: { facing: "north" } })).toEqual(
			[]
		);
	});
});

describe("block face geometry", () => {
	it("does not occlude neighbours with rotated elements, while preserving custom-UV boundary faces", async () => {
		const { builder } = fixtureBuilder();
		const element: BlockModelElement = {
			from: [0, 0, 0],
			to: [16, 16, 16],
			faces: { up: { texture: "block/stone", cullface: "up", uv: [0, 0, 8, 8] } },
		};
		const unrotated = await builder.createOptimizedFaceData({ elements: [element] });
		const rotated = await builder.createOptimizedFaceData({
			elements: [{ ...element, rotation: { axis: "y", angle: 45, origin: [8, 8, 8] } }],
		});
		const zeroAngle = await builder.createOptimizedFaceData({
			elements: [{ ...element, rotation: { axis: "y", angle: 0, origin: [8, 8, 8] } }],
		});
		expect(unrotated.cullableFaces.get("up")?.[0].canBatch).toBe(false);
		expect(getBlockOcclusionFlags({ ...unrotated, isCube: true, hasCullableFaces: true })).toBe(
			1 << 3
		);
		expect(getBlockOcclusionFlags({ ...rotated, isCube: false, hasCullableFaces: true })).toBe(0);
		expect(getBlockOcclusionFlags({ ...zeroAngle, isCube: true, hasCullableFaces: true })).toBe(
			1 << 3
		);
	});

	it.each<[{ direction: FaceDirection; uv: number[] }]>([
		[{ direction: "down", uv: [2, 2, 10, 10] }],
		[{ direction: "up", uv: [2, 6, 10, 14] }],
		[{ direction: "north", uv: [6, 4, 14, 12] }],
		[{ direction: "south", uv: [2, 4, 10, 12] }],
		[{ direction: "west", uv: [6, 4, 14, 12] }],
		[{ direction: "east", uv: [2, 4, 10, 12] }],
	])("derives partial-face UVs in both mesh paths: %j", async ({ direction, uv }) => {
		const { builder } = fixtureBuilder();
		const model = modelWithFace(direction);
		const original = JSON.stringify(model);
		const expected = [
			uv[0] / 16,
			1 - uv[1] / 16,
			uv[2] / 16,
			1 - uv[1] / 16,
			uv[0] / 16,
			1 - uv[3] / 16,
			uv[2] / 16,
			1 - uv[3] / 16,
		];
		const indexed = meshes(await builder.createBlockMesh(model));
		const optimized = (await builder.createOptimizedFaceData(model)).nonCullableFaces;
		expect(Array.from(indexed[0].geometry.getAttribute("uv").array)).toEqual(expected);
		expect(Array.from(optimized[0].geometry.getAttribute("uv").array)).toEqual(expected);
		expect(optimized[0].canBatch).toBe(false);
		expect(JSON.stringify(model)).toBe(original);
	});

	it("preserves explicit UVs and makes paired thin faces front-sided", async () => {
		const { builder } = fixtureBuilder();
		const model: BlockModel = {
			elements: [
				{
					from: [0, 0, 8],
					to: [16, 16, 8],
					faces: {
						north: { texture: "block/chain", uv: [1, 2, 3, 4] },
						south: { texture: "block/chain" },
					},
				},
			],
		};
		const indexed = meshes(await builder.createBlockMesh(model));
		const optimized = (await builder.createOptimizedFaceData(model)).nonCullableFaces;
		expect(indexed.map((mesh) => mesh.material.side)).toEqual([THREE.FrontSide, THREE.FrontSide]);
		expect(optimized.map((face) => face.material.side)).toEqual([THREE.FrontSide, THREE.FrontSide]);
		expect(Array.from(indexed[0].geometry.getAttribute("uv").array).slice(0, 2)).toEqual([
			1 / 16,
			1 - 2 / 16,
		]);
	});

	it("keeps emissive overlays separate from base faces without changing shared models or materials", async () => {
		const { builder, baseMaterial } = fixtureBuilder();
		const element: BlockModelElement = {
			from: [0, 0, 0],
			to: [16, 16, 16],
			faces: { north: { texture: "block/lamp" } },
		};
		const model = { elements: [element, { ...element, light_emission: 15 }] };
		const original = JSON.stringify(model);
		const indexed = meshes(await builder.createBlockMesh(model));
		expect(indexed).toHaveLength(2);
		const lit = indexed.find(
			(mesh) =>
				mesh.material.emissiveIntensity === 1 && mesh.material.emissive.getHex() === 0xffffff
		)!;
		expect(lit.material.emissiveMap).toBe(baseMaterial.map);
		expect(lit.material.color.getHex()).toBe(0);
		expect(lit.material.depthWrite).toBe(false);
		expect(lit.material.polygonOffsetFactor).toBe(-1);
		const optimized = (await builder.createOptimizedFaceData(model)).nonCullableFaces;
		expect(optimized.map((face) => face.material.depthWrite)).toEqual([true, false]);
		expect(baseMaterial.depthWrite).toBe(true);
		expect(baseMaterial.emissive.getHex()).toBe(0);
		expect(JSON.stringify(model)).toBe(original);
	});

	it("tints cauldron water using water rather than the container block", async () => {
		const { builder, loader } = fixtureBuilder();
		const tint = vi.spyOn(loader, "getTint");
		await builder.createBlockMesh(
			{
				elements: [
					{
						from: [2, 6, 2],
						to: [14, 6, 14],
						faces: { up: { texture: "block/water_still", tintindex: 0 } },
					},
				],
			},
			{},
			{ namespace: "minecraft", name: "water_cauldron", properties: { level: "1" } }
		);
		expect(tint).toHaveBeenCalledWith("minecraft:water", { level: "1" }, "plains");
	});
});

describe("foliage and blockstate-dependent parts", () => {
	it("loads dry foliage colormaps, infers new leaves, and keeps fallback colors independent", async () => {
		const loader = new AssetLoader(false);
		const data = {
			width: 1,
			height: 1,
			data: new Uint8ClampedArray([120, 60, 30, 255]),
			colorSpace: "srgb",
		} as ImageData;
		const pixels = vi
			.spyOn(loader, "getTexturePixels")
			.mockImplementation(async (path) => (path === "colormap/dry_foliage" ? data : null));
		await loader.loadColormaps();
		expect(pixels).toHaveBeenCalledWith("colormap/dry_foliage");
		expect(loader.getTint("minecraft:leaf_litter", {})).toEqual(
			new THREE.Color(120 / 255, 60 / 255, 30 / 255)
		);
		const tints = new TintManager();
		expect(tints.isTintable("minecraft:mangrove_leaves")).toBe(true);
		expect(tints.isTintable("minecraft:bush")).toBe(true);
		expect(tints.getTint("minecraft:leaf_litter", {}).getHex()).toBe(0x5c3c32);
		tints.getTint("minecraft:leaf_litter", {}).set(0);
		expect(tints.getTint("minecraft:leaf_litter", {}).getHex()).toBe(0x5c3c32);
	});

	it.each([
		["north", 0],
		["east", -90],
		["south", 180],
		["west", 90],
	])("places lectern books for facing %s", async (facing, yaw) => {
		const cubane = new Cubane({ autoRestore: false });
		vi.spyOn(cubane.modelResolver, "resolveBlockModel").mockResolvedValue([]);
		const entity = vi
			.spyOn(cubane, "getEntityMesh")
			.mockImplementation(async () => new THREE.Group());
		const empty = await cubane.getBlockMesh(`minecraft:lectern[facing=${facing},has_book=false]`);
		expect(empty.children).toHaveLength(0);
		expect(entity).not.toHaveBeenCalled();
		const book = (await cubane.getBlockMesh(`minecraft:lectern[facing=${facing},has_book=true]`))
			.children[0];
		expect(book.position.toArray()).toEqual([0, 9 / 16, 0]);
		expect(book.rotation.order).toBe("YXZ");
		expect(book.rotation.x).toBeCloseTo(THREE.MathUtils.degToRad(67.5));
		expect(book.rotation.y).toBeCloseTo(THREE.MathUtils.degToRad(Number(yaw)));
		cubane.dispose();
	});
});

describe("texture alpha classification", () => {
	it.each([
		{ alpha: [255, 255], transparent: false, alphaTest: 0 },
		{ alpha: [255, 0], transparent: false, alphaTest: 0.01 },
		{ alpha: [255, 128], transparent: true, alphaTest: 0.01 },
	])("uses the correct render pass for alpha $alpha", async ({ alpha, transparent, alphaTest }) => {
		const data = new Uint8ClampedArray(alpha.flatMap((a) => [255, 255, 255, a]));
		const context = { drawImage: vi.fn(), getImageData: vi.fn(() => ({ data })) };
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
			(() => context) as unknown as HTMLCanvasElement["getContext"]
		);
		const loader = new AssetLoader(false);
		const image = document.createElement("img");
		image.width = 2;
		image.height = 1;
		vi.spyOn(loader, "getTexture").mockResolvedValue(new THREE.Texture(image));
		vi.spyOn(loader, "getResourceString").mockResolvedValue(undefined);
		const material = await loader.getMaterial("block/mangrove_log", { useAtlas: false });
		expect(material.transparent).toBe(transparent);
		expect(material.alphaTest).toBe(alphaTest);
		expect(material.depthWrite).toBe(true);
	});

	it("reads only the requested sprite region, excluding other atlas textures", () => {
		const context = {
			drawImage: vi.fn(),
			getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) })),
		};
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
			(() => context) as unknown as HTMLCanvasElement["getContext"]
		);
		const image = document.createElement("img");
		image.width = 64;
		image.height = 64;
		const loader = new AssetLoader(false);
		expect(
			loader.analyzeTextureTransparency(new THREE.Texture(image), {
				u: 0.25,
				v: 0.5,
				width: 0.25,
				height: 0.25,
			}).transparencyType
		).toBe("opaque");
		expect(context.drawImage).toHaveBeenCalledWith(image, 16, 32, 16, 16, 0, 0, 16, 16);
	});
});
