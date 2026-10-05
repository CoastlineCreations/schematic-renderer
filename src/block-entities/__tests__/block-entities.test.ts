import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BoxGeometry,
	Euler,
	Group,
	InstancedMesh,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	Texture,
	Vector3,
} from "three";
import {
	applyLegacyNotchTransparencyHack,
	bakeBannerGeometries,
	bakeCopperChestGeometry,
	bakeShulkerBoxGeometry,
	BlockEntityRendererRegistry,
	compositeBannerPixels,
	createCopperChestOverlay,
	createCustomPlayerHeadOverlay,
	createMinecraftHeadGeometry,
	DECORATED_POT_BLANK_SIDE_TEXTURE,
	filterBlockEntitySnapshot,
	mapDecoratedPotSherds,
	parseBannerPatternLayers,
	parseBlockEntityPosition,
	parsePaletteBlockState,
	parseSanitizedPlayerHead,
	renderBlockEntities,
	resolveBannerRotation,
	resolveCopperChest,
	resolveCustomPlayerHead,
	resolveShulkerBoxRotation,
	selectBanners,
	selectCustomPlayerHeadsFromSchematic,
	selectDecoratedPots,
	selectShulkerBoxes,
} from "..";
import type {
	BlockEntityOverlay,
	BlockEntityRenderer,
	BlockEntityResources,
	BlockEntitySchematic,
	BlockEntitySnapshot,
	CustomPlayerHead,
	SchematicPosition,
} from "..";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const hash = "a".repeat(64);
const encodedSkin = (url = `https://textures.minecraft.net/texture/${hash}`) =>
	btoa(JSON.stringify({ textures: { SKIN: { url } } }));
const headEntity = (position: SchematicPosition, value = encodedSkin()) => ({
	id: "minecraft:skull",
	position,
	nbt: { SkullOwner: { Properties: { textures: [{ Value: value }] } } },
});
const headState = { name: "minecraft:player_head", properties: { rotation: "4" } };
const snapshot = (
	palette: unknown[],
	blocks: unknown[],
	entities: unknown[] = []
): BlockEntitySnapshot => ({ palette, blocks, entities });
const schematic = (data = snapshot([], [])): BlockEntitySchematic => ({
	group: new Group(),
	schematicWrapper: {
		get_palette: () => data.palette,
		blocks_indices: () => data.blocks,
		get_all_block_entities: () => data.entities,
	},
});
const resources = (): BlockEntityResources => ({
	getEntityMesh: vi.fn().mockRejectedValue(new Error("missing model")),
	getTexture: vi.fn().mockRejectedValue(new Error("missing texture")),
});

function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("Expected fixture value");
	return value;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function boxModel() {
	const root = new Group();
	const part = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
	root.add(part);
	return { root, part };
}

describe("NBT selection and Minecraft geometry", () => {
	it("preserves inline state properties and typed positions", () => {
		expect(
			parsePaletteBlockState({
				Name: "minecraft:player_head[rotation=12]",
				Properties: { waterlogged: true },
			})
		).toEqual({
			name: "minecraft:player_head",
			properties: { rotation: "12", waterlogged: "true" },
		});
		expect(parseBlockEntityPosition({ x: -2, y: 3, z: 4 })).toEqual([-2, 3, 4]);
		expect(parseBlockEntityPosition({ nbt: { Data: { Pos: new Int32Array([1, 2, 3]) } } })).toEqual(
			[1, 2, 3]
		);
		expect(parseBlockEntityPosition({ x: 1.2, y: 0, z: 0 })).toBeNull();
	});

	it("reads standard legacy and modern skin profiles plus former metadata aliases", () => {
		expect(parseSanitizedPlayerHead(headEntity([1, 2, 3]))).toEqual({
			position: [1, 2, 3],
			textureHash: hash,
		});
		expect(
			parseSanitizedPlayerHead({
				x: 1,
				y: 2,
				z: 3,
				profile: { properties: [{ name: "textures", value: encodedSkin() }] },
			})?.textureHash
		).toBe(hash);
		expect(
			parseSanitizedPlayerHead({ position: [1, 2, 3], nbt: { CoastlineStudioTextureHash: hash } })
				?.textureHash
		).toBe(hash);
		expect(
			parseSanitizedPlayerHead(
				headEntity([1, 2, 3], encodedSkin("https://untrusted.example/texture/" + hash))
			)
		).toBeNull();
		expect(
			parseSanitizedPlayerHead({
				...headEntity([1, 2, 3]),
				nbt: { Pos: [4, 5, 6], CoastlineStudioTextureHash: hash },
			})
		).toBeNull();
	});

	it("selects palette-backed heads without NBT and retains profile lookup fallbacks", () => {
		const data = snapshot(
			[headState],
			[new Int32Array([1, 2, 3, 0]), [1, 2, 3, 0], [4, 5, 6, 0]],
			[
				{
					position: [4, 5, 6],
					nbt: { SkullOwner: { Id: "12345678-1234-1234-1234-123456789abc", Name: "Player" } },
				},
			]
		);
		const heads = selectCustomPlayerHeadsFromSchematic({}, data);
		expect(heads).toHaveLength(2);
		expect(heads[0]).toMatchObject({
			textureHash: null,
			offset: [0, -0.25, 0],
			rotationY: -Math.PI / 2,
		});
		expect(heads[1]).toMatchObject({
			profileIdentifier: "12345678123412341234123456789abc",
			profileFallbackIdentifier: "Player",
		});
	});

	it.each([
		["north", [0, 0, 0.25], Math.PI],
		["south", [0, 0, -0.25], 0],
		["west", [0.25, 0, 0], -Math.PI / 2],
		["east", [-0.25, 0, 0], Math.PI / 2],
	] as const)("orients a %s wall head", (facing, offset, rotationY) => {
		expect(
			resolveCustomPlayerHead(
				{
					position: [0, 0, 0],
					textureHash: null,
					profileIdentifier: null,
					profileFallbackIdentifier: null,
				},
				{ name: "minecraft:player_wall_head", properties: { facing } }
			)
		).toMatchObject({ offset, rotationY });
	});

	it("builds exact head/hat sizes and modern versus legacy UV heights", () => {
		const modern = createMinecraftHeadGeometry(),
			legacy = createMinecraftHeadGeometry(false, true),
			hat = createMinecraftHeadGeometry(true);
		expect(modern.parameters.width).toBe(0.5);
		expect(hat.parameters.width).toBe(9 / 16);
		expect(modern.getAttribute("uv").getY(0)).toBe(1 - 8 / 64);
		expect(legacy.getAttribute("uv").getY(0)).toBe(1 - 8 / 32);
		// Bottom is vertically reversed relative to other cube faces.
		expect(modern.getAttribute("uv").getY(12)).toBe(1 - 8 / 64);
		modern.dispose();
		legacy.dispose();
		hat.dispose();
	});

	it("removes opaque legacy Notch headwear while preserving real alpha skins", () => {
		const pixels = new Uint8ClampedArray(64 * 32 * 4).fill(255);
		expect(applyLegacyNotchTransparencyHack(pixels, 64, 32)).toBe(true);
		expect(pixels[(8 * 64 + 40) * 4 + 3]).toBe(0);
		expect(pixels[(8 * 64 + 8) * 4 + 3]).toBe(255);
		const transparent = new Uint8ClampedArray(64 * 32 * 4).fill(255);
		transparent[32 * 4 + 3] = 64;
		expect(applyLegacyNotchTransparencyHack(transparent, 64, 32)).toBe(false);
		expect(transparent[(8 * 64 + 40) * 4 + 3]).toBe(255);
	});

	it("maps all four pot faces in vanilla order, joins raw XYZ NBT, and retains blank pots", () => {
		const sides = mapDecoratedPotSherds([
			"minecraft:angler_pottery_sherd",
			"minecraft:brick",
			"minecraft:flow_pottery_sherd",
			"../unsafe",
		]);
		expect(sides).toEqual([
			"entity/decorated_pot/angler_pottery_pattern",
			DECORATED_POT_BLANK_SIDE_TEXTURE,
			"entity/decorated_pot/flow_pottery_pattern",
			DECORATED_POT_BLANK_SIDE_TEXTURE,
		]);
		const pots = selectDecoratedPots(
			snapshot(
				["minecraft:decorated_pot[facing=east]"],
				[
					[1, 2, 3, 0],
					[4, 5, 6, 0],
				],
				[{ x: 1, y: 2, z: 3, sherds: ["minecraft:angler_pottery_sherd"] }]
			)
		);
		expect(pots).toHaveLength(2);
		expect(pots[0]).toMatchObject({ rotationY: -Math.PI / 2 });
		expect(pots[0].sideTextures[0]).toBe(sides[0]);
		expect(pots[1].sideTextures.every((side) => side === DECORATED_POT_BLANK_SIDE_TEXTURE)).toBe(
			true
		);
	});

	it("selects waxed oxidation, double chest side, and rotation independently", () => {
		expect(
			resolveCopperChest(
				{
					name: "minecraft:waxed_weathered_copper_chest",
					properties: { type: "left", facing: "east" },
				},
				[1, 2, 3]
			)
		).toMatchObject({
			stage: "weathered",
			model: "chest_left",
			texturePath: "entity/chest/copper_weathered_left",
			rotationY: -Math.PI / 2,
		});
		expect(
			resolveCopperChest(
				{ name: "minecraft:copper_chest", properties: { type: "invalid" } },
				[0, 0, 0]
			)
		).toBeNull();
	});

	it.each([
		["up", [0, 1, 0]],
		["down", [0, -1, 0]],
		["north", [0, 0, -1]],
		["south", [0, 0, 1]],
		["east", [1, 0, 0]],
		["west", [-1, 0, 0]],
	] as const)("points a %s shulker lid along its block facing", (facing, expected) => {
		const rotation = required(resolveShulkerBoxRotation(facing));
		expect(rotation).not.toBeNull();
		const direction = new Vector3(0, 1, 0).applyEuler(new Euler(...rotation));
		direction
			.toArray()
			.forEach((coordinate, index) => expect(coordinate).toBeCloseTo(expected[index]));
	});

	it("keeps dyed shulkers and rejects unsupported facings", () => {
		expect(
			selectShulkerBoxes(
				snapshot(
					["minecraft:red_shulker_box[facing=west]", "minecraft:shulker_box[facing=invalid]"],
					[
						[0, 0, 0, 0],
						[1, 0, 0, 1],
					]
				)
			)
		).toMatchObject([{ variant: "red", texturePath: "entity/shulker/shulker_red" }]);
	});

	it.each([bakeCopperChestGeometry, bakeShulkerBoxGeometry])(
		"bakes world transforms without mutating shared model geometry",
		(bake) => {
			const { root, part } = boxModel();
			root.position.set(3, 4, 5);
			part.position.set(2, 0, 0);
			const geometry = required(bake(root));
			expect(geometry).not.toBeNull();
			geometry.computeBoundingBox();
			expect(required(geometry.boundingBox).min.toArray()).toEqual([4.5, 3.5, 4.5]);
			part.geometry.computeBoundingBox();
			expect(required(part.geometry.boundingBox).min.toArray()).toEqual([-0.5, -0.5, -0.5]);
			geometry.dispose();
			part.geometry.dispose();
			part.material.dispose();
		}
	);

	it("parses old banner codes and modern components in stored layer order", () => {
		const patterns = [
			{ Pattern: "bs", Color: 14 },
			{ pattern: "minecraft:creeper", color: "blue" },
			{ pattern: "mod:unsafe", color: "red" },
		];
		expect(parseBannerPatternLayers(patterns)).toEqual([
			{ pattern: "stripe_bottom", color: "red" },
			{ pattern: "creeper", color: "blue" },
		]);
		const selected = selectBanners(
			snapshot(
				["minecraft:white_wall_banner[facing=east]"],
				[[1, 2, 3, 0]],
				[{ x: 1, y: 2, z: 3, components: { "minecraft:banner_patterns": patterns } }]
			)
		);
		expect(selected[0]).toMatchObject({
			attachment: "wall",
			baseColor: "white",
			rotationY: Math.PI / 2,
			patterns: parseBannerPatternLayers(patterns),
		});
		expect(resolveBannerRotation("standing", { rotation: "4" })).toBe(-Math.PI / 2);
	});

	it("composites banner dye masks in order without changing inputs", () => {
		const base = new Uint8ClampedArray([0, 0, 0, 0]);
		const white = new Uint8ClampedArray([255, 255, 255, 255]);
		const half = new Uint8ClampedArray([255, 255, 255, 128]);
		expect(
			Array.from(
				compositeBannerPixels(base, [
					{ pixels: white, color: 0xff0000 },
					{ pixels: half, color: 0x0000ff },
				])
			)
		).toEqual([127, 0, 128, 255]);
		expect(Array.from(base)).toEqual([0, 0, 0, 0]);
	});

	it("derives wall banner geometry separately from standing pole geometry", () => {
		const model = new Group();
		for (const name of ["top", "slate", "stand"]) {
			const part = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
			part.name = name;
			model.add(part);
		}
		const result = required(bakeBannerGeometries(model));
		expect(result).not.toBeNull();
		expect(result.standingWood.getAttribute("position").count).toBe(48);
		expect(result.wallWood.getAttribute("position").count).toBe(24);
		expect(result.wallFlag).not.toBe(result.standingFlag);
		Object.values(result).forEach((geometry) => geometry.dispose());
	});
});

describe("native registry and resource lifetime", () => {
	it("delegates built-in families and permits per-ID replacement", () => {
		const registry = new BlockEntityRendererRegistry();
		for (const name of [
			"minecraft:player_head",
			"minecraft:player_wall_head",
			"minecraft:decorated_pot",
			"minecraft:waxed_oxidized_copper_chest",
			"minecraft:blue_shulker_box",
			"minecraft:red_wall_banner",
		])
			expect(registry.handles(name)).toBe(true);
		expect(registry.handles("minecraft:stone")).toBe(false);
		registry.register({
			id: "minecraft:shulker_box",
			supportsBlock: () => false,
			render: async () => ({ count: 0, dispose() {} }),
		});
		expect(registry.handles("minecraft:blue_shulker_box")).toBe(false);
		expect(new BlockEntityRendererRegistry({ enabled: false }).handles("minecraft:banner")).toBe(
			false
		);
	});

	it("filters slices using inclusive minima and exclusive maxima for blocks and entities", () => {
		const data = snapshot(
			["minecraft:player_head"],
			[
				[0, 0, 0, 0],
				[1, 0, 0, 0],
			],
			[headEntity([0, 0, 0]), headEntity([1, 0, 0])]
		);
		expect(
			filterBlockEntitySnapshot(data, {
				enabled: true,
				min: { x: 0, y: 0, z: 0 },
				max: { x: 1, y: 1, z: 1 },
			})
		).toMatchObject({ blocks: [[0, 0, 0, 0]], entities: [headEntity([0, 0, 0])] });
		expect(
			filterBlockEntitySnapshot(data, {
				enabled: false,
				min: { x: 0, y: 0, z: 0 },
				max: { x: 0, y: 0, z: 0 },
			})
		).toBe(data);
	});

	it("uses resource-pack default skins with no remote lookup and disposes clones exactly once", async () => {
		const source = new Texture({ width: 64, height: 64 });
		const sourceDisposed = vi.fn();
		source.addEventListener("dispose", sourceDisposed);
		const provider = resources();
		provider.getTexture = vi.fn().mockResolvedValue(source);
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const model = schematic(snapshot([headState], [[1, 2, 3, 0]], [headEntity([1, 2, 3])]));
		const overlay = await createCustomPlayerHeadOverlay(
			model,
			new AbortController().signal,
			undefined,
			provider
		);
		expect(overlay.count).toBe(1);
		expect(fetch).not.toHaveBeenCalled();
		const mesh = model.group.children[0].children[0] as InstancedMesh<
			BoxGeometry,
			MeshBasicMaterial
		>;
		const matrix = new Matrix4();
		mesh.getMatrixAt(0, matrix);
		expect(new Vector3().setFromMatrixPosition(matrix).toArray()).toEqual([1, 1.75, 3]);
		const clone = mesh.material.map;
		expect(clone).not.toBe(source);
		const cloneDisposed = vi.fn();
		clone?.addEventListener("dispose", cloneDisposed);
		overlay.dispose();
		overlay.dispose();
		expect(cloneDisposed).toHaveBeenCalledTimes(1);
		expect(sourceDisposed).not.toHaveBeenCalled();
		expect(model.group.children).toHaveLength(0);
	});

	it("renders chest instances using owned texture clones and shared source geometry", async () => {
		const { root, part } = boxModel(),
			source = new Texture();
		const provider = resources();
		provider.getEntityMesh = vi.fn().mockResolvedValue(root);
		provider.getTexture = vi.fn().mockResolvedValue(source);
		const sourceDisposed = vi.fn();
		source.addEventListener("dispose", sourceDisposed);
		const geometryDisposed = vi.fn();
		part.geometry.addEventListener("dispose", geometryDisposed);
		const data = snapshot(
			["minecraft:copper_chest"],
			[
				[0, 0, 0, 0],
				[1, 0, 0, 0],
			]
		);
		const model = schematic(data),
			overlay = await createCopperChestOverlay(model, new AbortController().signal, data, provider);
		expect(overlay.count).toBe(2);
		const mesh = model.group.children[0].children[0] as InstancedMesh<
			BoxGeometry,
			MeshBasicMaterial
		>;
		expect(mesh.count).toBe(2);
		expect(required(mesh.material.map).flipY).toBe(false);
		expect(source.flipY).toBe(true);
		overlay.dispose();
		overlay.dispose();
		expect(sourceDisposed).not.toHaveBeenCalled();
		expect(geometryDisposed).not.toHaveBeenCalled();
	});

	it("does no snapshot or resource work when already aborted", async () => {
		const model = schematic();
		const scan = vi.fn();
		model.schematicWrapper.get_palette = scan;
		const controller = new AbortController();
		controller.abort();
		expect((await renderBlockEntities(model, controller.signal, resources())).count).toBe(0);
		expect(scan).not.toHaveBeenCalled();
	});

	it("disposes finished overlays on abort and late completions before publication", async () => {
		const controller = new AbortController(),
			model = schematic(),
			late = deferred<BlockEntityOverlay>();
		const disposed = vi.fn(),
			lateDisposed = vi.fn();
		const renderers: BlockEntityRenderer[] = [
			{
				id: "ready",
				supportsBlock: () => false,
				render: async () => ({ count: 1, dispose: disposed }),
			},
			{ id: "late", supportsBlock: () => false, render: () => late.promise },
		];
		const pending = renderBlockEntities(model, controller.signal, resources(), {
			includeDefaultRenderers: false,
			renderers,
		});
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		controller.abort();
		const result = await pending;
		expect(result.count).toBe(0);
		expect(disposed).toHaveBeenCalledTimes(1);
		late.resolve({ count: 1, dispose: lateDisposed });
		await vi.waitFor(() => expect(lateDisposed).toHaveBeenCalledTimes(1));
		result.dispose();
		expect(disposed).toHaveBeenCalledTimes(1);
	});

	it("isolates renderer errors and diagnostic hook exceptions", async () => {
		const dispose = vi.fn(),
			error = new Error("renderer failed");
		const onError = vi.fn(() => {
			throw new Error("diagnostic failed");
		});
		const result = await renderBlockEntities(
			schematic(),
			new AbortController().signal,
			resources(),
			{
				includeDefaultRenderers: false,
				onError,
				renderers: [
					{
						id: "bad",
						supportsBlock: () => false,
						render: async () => {
							throw error;
						},
					},
					{ id: "ok", supportsBlock: () => false, render: async () => ({ count: 2, dispose }) },
				],
			}
		);
		expect(result.count).toBe(2);
		expect(onError).toHaveBeenCalledWith("bad", error);
		result.dispose();
		result.dispose();
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("resolves each custom head identity once and passes only configured URLs to fetch", async () => {
		const source = new Texture({ width: 64, height: 64 }),
			provider = resources();
		provider.getTexture = vi.fn().mockResolvedValue(source);
		const fetch = vi.fn().mockResolvedValue(
			new Response(new Blob(["png"], { type: "image/png" }), {
				headers: { "content-type": "image/png" },
			})
		);
		vi.stubGlobal("fetch", fetch);
		const close = vi.fn();
		vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 64, height: 64, close }));
		const resolve = vi.fn(
			(
				head: Readonly<
					Pick<CustomPlayerHead, "textureHash" | "profileIdentifier" | "profileFallbackIdentifier">
				>
			) => ({ key: head.textureHash ?? "profile", url: "https://skin.example/skin.png" })
		);
		const data = snapshot(
			[headState],
			[
				[0, 0, 0, 0],
				[1, 0, 0, 0],
			],
			[headEntity([0, 0, 0]), headEntity([1, 0, 0])]
		);
		const result = await createCustomPlayerHeadOverlay(
			schematic(data),
			new AbortController().signal,
			data,
			provider,
			{ resolveTexture: resolve }
		);
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0][0]).toBe("https://skin.example/skin.png");
		expect(result.count).toBe(2);
		result.dispose();
		expect(close).toHaveBeenCalledTimes(1);
	});
	it("bounds remote skin requests while rendering every head with a default fallback", async () => {
		const fetch = vi
			.fn()
			.mockImplementation(() =>
				Promise.resolve(
					new Response(new Blob(["png"]), { headers: { "content-type": "image/png" } })
				)
			);
		vi.stubGlobal("fetch", fetch);
		const close = vi.fn();
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn().mockImplementation(() => Promise.resolve({ width: 64, height: 64, close }))
		);
		const blocks = Array.from({ length: 66 }, (_, index) => [index, 0, 0, 0]);
		const entities = blocks.map((block, index) =>
			headEntity(
				[block[0], 0, 0],
				encodedSkin(
					`https://textures.minecraft.net/texture/${index.toString(16).padStart(64, "0")}`
				)
			)
		);
		const data = snapshot([headState], blocks, entities);
		const model = schematic(data);
		const result = await createCustomPlayerHeadOverlay(
			model,
			new AbortController().signal,
			data,
			resources(),
			{
				defaultTextureUrl: "https://skin.example/default.png",
				resolveTexture: (head) => ({
					key: head.textureHash ?? "profile",
					url: `https://skin.example/${head.textureHash}.png`,
				}),
			}
		);
		expect(result.count).toBe(66);
		expect(fetch).toHaveBeenCalledTimes(65);
		result.dispose();
		expect(close).toHaveBeenCalledTimes(65);
	});

	it("closes decoded skin images that finish after an aborted rebuild", async () => {
		const decoding = deferred<{ width: number; height: number; close: () => void }>();
		const decode = vi.fn().mockReturnValue(decoding.promise);
		vi.stubGlobal("createImageBitmap", decode);
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockImplementation(() =>
					Promise.resolve(
						new Response(new Blob(["png"]), { headers: { "content-type": "image/png" } })
					)
				)
		);
		const model = schematic(snapshot([headState], [[0, 0, 0, 0]]));
		const controller = new AbortController();
		const pending = renderBlockEntities(model, controller.signal, resources(), {
			playerHeads: { defaultTextureUrl: "https://skin.example/default.png" },
		});
		await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1));
		controller.abort();
		expect((await pending).count).toBe(0);
		const close = vi.fn();
		decoding.resolve({ width: 64, height: 64, close });
		await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
		expect(model.group.children).toHaveLength(0);
	});
});
