import {
	BoxGeometry,
	DoubleSide,
	Group,
	InstancedMesh,
	LinearSRGBColorSpace,
	Matrix4,
	MeshLambertMaterial,
	NearestFilter,
	Quaternion,
	StaticDrawUsage,
	Texture,
	Vector3,
} from "three";

import {
	asRecord,
	parseIndexedSchematicBlock,
	parsePaletteBlockState,
	parseSchematicPosition as parsePosition,
} from "./types";
import type {
	BlockEntitySnapshot,
	BlockEntityResources,
	BlockEntitySchematic,
	BlockEntitySchematicWrapper,
	BlockEntityBlockState,
	UnknownRecord,
	SchematicPosition,
} from "./types";

const SANITIZED_PLAYER_HEAD_ID = "schematic_hub:player_head";
const HEAD_TEXTURE_HASH_PATTERN = /^[a-f0-9]{32,64}$/;
const HEAD_TEXTURE_PATH_PATTERN = /^\/texture\/([a-f0-9]{32,64})$/i;
const PROFILE_UUID_PATTERN =
	/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9_]{1,16}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const LEGACY_TEXTURE_PAYLOAD_PATTERN =
	/^\s*\{\s*(?:"textures"|textures)\s*:\s*\{\s*(?:"SKIN"|SKIN)\s*:\s*\{\s*(?:"url"|url)\s*:\s*"([^"\\]{1,2048})"\s*\}\s*\}\s*\}\s*$/;
const MAX_HEAD_TEXTURE_BYTES = 2 * 1024 * 1024;
const MAX_TEXTURE_PROPERTY_LENGTH = 8_192;
const MAX_TEXTURE_PROPERTY_BYTES = 6_144;
const MAX_PROFILE_PROPERTIES_INSPECTED = 32;
const DEFAULT_HEAD_TEXTURE_KEY = "default";
const DEFAULT_HEAD_TEXTURE_PATHS = ["entity/player/wide/steve", "entity/steve"] as const;

export const MAX_CUSTOM_PLAYER_HEADS = 256;
export const MAX_CUSTOM_HEAD_TEXTURES = 64;
export const MAX_CUSTOM_HEAD_ENTITIES_INSPECTED = 1_024;
export const MAX_CUSTOM_HEAD_BLOCKS_INSPECTED = 750_000;
export const CUSTOM_HEAD_TEXTURE_CONCURRENCY = 4;
export const CUSTOM_HEAD_TEXTURE_LOAD_BUDGET_MS = 12_000;

type Position = SchematicPosition;
const FALLBACK_HEAD_MATERIAL_KEY = "schematic-renderer:fallback-player-head";

export type SanitizedPlayerHead = {
	position: Position;
	textureHash: string;
};

export type PlayerHeadCandidate = {
	position: Position;
	textureHash: string | null;
	profileIdentifier: string | null;
	profileFallbackIdentifier: string | null;
};

export type HeadBlockState = BlockEntityBlockState;

export type CustomPlayerHead = PlayerHeadCandidate & {
	rotationY: number;
	offset: Position;
};

export type CustomPlayerHeadOverlay = {
	count: number;
	dispose: () => void;
};

type HeadSchematicWrapper = BlockEntitySchematicWrapper;

export type CustomHeadSchematic = BlockEntitySchematic;

type LoadedTexture = {
	texture: Texture;
	legacyLayout: boolean;
	closeImage: () => void;
};

export type HeadTextureRequest = {
	key: string;
	url: string;
	fallbackUrl?: string | null;
	cache?: RequestCache;
	credentials?: RequestCredentials;
	description?: string;
};

/** External player-skin lookups are opt-in; resource-pack Steve is the default. */
export type PlayerHeadOptions = {
	/** PNG skin URL for the default player. Omit to use the active resource pack. */
	defaultTextureUrl?: string;
	/** Resolve validated texture hashes/profile identifiers to your own endpoint or URL. */
	resolveTexture?: (head: Readonly<PlayerHeadTextureReference>) => HeadTextureRequest | null;
};

export type PlayerHeadTextureReference = Pick<
	PlayerHeadCandidate,
	"textureHash" | "profileIdentifier" | "profileFallbackIdentifier"
>;

type MaterialPair = {
	base: MeshLambertMaterial;
	hat: MeshLambertMaterial | null;
};

const BASE_UV_RECTS = [
	[16, 8, 24, 16], // +X, player's left
	[0, 8, 8, 16], // -X, player's right
	[8, 0, 16, 8], // +Y, top
	[16, 0, 24, 8], // -Y, bottom
	[8, 8, 16, 16], // +Z, front
	[24, 8, 32, 16], // -Z, back
] as const;

const HAT_UV_RECTS = [
	[48, 8, 56, 16],
	[32, 8, 40, 16],
	[40, 0, 48, 8],
	[48, 0, 56, 8],
	[40, 8, 48, 16],
	[56, 8, 64, 16],
] as const;

function samePosition(first: Position, second: Position) {
	return first[0] === second[0] && first[1] === second[1] && first[2] === second[2];
}

function firstValue(record: UnknownRecord, ...keys: string[]) {
	for (const key of keys) {
		if (record[key] !== undefined) return record[key];
	}
	return undefined;
}

function firstRecord(record: UnknownRecord, ...keys: string[]) {
	return asRecord(firstValue(record, ...keys));
}

function firstString(record: UnknownRecord, ...keys: string[]) {
	const value = firstValue(record, ...keys);
	return typeof value === "string" ? value : null;
}

function textureUrlFromPropertyPayload(payload: string): string | null {
	try {
		const parsed = asRecord(JSON.parse(payload));
		const textures = parsed === null ? null : asRecord(parsed.textures);
		const skin = textures === null ? null : asRecord(textures.SKIN);
		return skin !== null && typeof skin.url === "string" ? skin.url : null;
	} catch {
		// Some older custom-head generators encoded Mojangson-like unquoted
		// `textures` and `SKIN` keys rather than JSON. Accept only that exact,
		// bounded shape; URL validation below remains identical.
		return LEGACY_TEXTURE_PAYLOAD_PATTERN.exec(payload)?.[1] ?? null;
	}
}

function textureHashFromPropertyValue(value: unknown): string | null {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_TEXTURE_PROPERTY_LENGTH ||
		value.length % 4 === 1 ||
		!BASE64_PATTERN.test(value)
	) {
		return null;
	}

	try {
		const binary = globalThis.atob(value);
		if (binary.length === 0 || binary.length > MAX_TEXTURE_PROPERTY_BYTES) return null;
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		const rawUrl = textureUrlFromPropertyPayload(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes)
		);
		if (rawUrl === null) return null;

		const url = new URL(rawUrl);
		if (
			(url.protocol !== "http:" && url.protocol !== "https:") ||
			url.hostname !== "textures.minecraft.net" ||
			url.username !== "" ||
			url.password !== "" ||
			url.port !== "" ||
			url.search !== "" ||
			url.hash !== ""
		) {
			return null;
		}
		const path = HEAD_TEXTURE_PATH_PATTERN.exec(url.pathname);
		return path?.[1]?.toLowerCase() ?? null;
	} catch {
		return null;
	}
}

function textureHashFromPropertyList(value: unknown, requireName: boolean): string | null {
	if (!Array.isArray(value)) return null;
	const inspected = Math.min(value.length, MAX_PROFILE_PROPERTIES_INSPECTED);
	for (let index = 0; index < inspected; index += 1) {
		const property = asRecord(value[index]);
		if (property === null) continue;
		if (requireName) {
			const name = firstString(property, "name", "Name");
			if (name?.toLowerCase() !== "textures") continue;
		}
		const hash = textureHashFromPropertyValue(firstValue(property, "value", "Value"));
		if (hash !== null) return hash;
	}
	return null;
}

function textureHashFromProperties(value: unknown): string | null {
	if (Array.isArray(value)) return textureHashFromPropertyList(value, true);
	const properties = asRecord(value);
	if (properties === null) return null;
	return textureHashFromPropertyList(firstValue(properties, "textures", "Textures"), false);
}

function textureHashFromRawData(data: UnknownRecord): string | null {
	const owner = firstRecord(data, "SkullOwner", "skull_owner", "skullOwner", "Owner", "owner");
	if (owner !== null) {
		const legacy = textureHashFromProperties(firstValue(owner, "Properties", "properties"));
		if (legacy !== null) return legacy;
	}

	const profile = firstRecord(data, "profile", "Profile");
	return profile === null
		? null
		: textureHashFromProperties(firstValue(profile, "properties", "Properties"));
}

function textureHashFromRawNbt(nbt: UnknownRecord): string | null {
	const wrappedData = firstRecord(nbt, "Data", "data");
	if (wrappedData !== null) {
		const wrapped = textureHashFromRawData(wrappedData);
		if (wrapped !== null) return wrapped;
	}
	return textureHashFromRawData(nbt);
}

function profileUuid(value: unknown): string | null {
	if (typeof value === "string") {
		return PROFILE_UUID_PATTERN.test(value) ? value.replace(/-/g, "").toLowerCase() : null;
	}
	const parts = Array.isArray(value)
		? value
		: ArrayBuffer.isView(value)
			? Array.from(value as unknown as ArrayLike<number>)
			: null;
	if (
		parts === null ||
		parts.length !== 4 ||
		parts.some(
			(part) => !Number.isInteger(part) || Number(part) < -0x8000_0000 || Number(part) > 0xffff_ffff
		)
	) {
		return null;
	}
	return parts.map((part) => (Number(part) >>> 0).toString(16).padStart(8, "0")).join("");
}

function profileName(value: unknown): string | null {
	return typeof value === "string" && PROFILE_NAME_PATTERN.test(value) ? value : null;
}

type ProfileIdentifiers = {
	uuid: string | null;
	name: string | null;
};

function identifiersFromProfile(value: unknown): ProfileIdentifiers {
	if (typeof value === "string") {
		return { uuid: profileUuid(value), name: profileName(value) };
	}
	const profile = asRecord(value);
	if (profile === null) return { uuid: null, name: null };
	return {
		uuid: profileUuid(firstValue(profile, "id", "Id", "uuid", "UUID")),
		name: profileName(firstValue(profile, "name", "Name")),
	};
}

function profileIdentifiersFromRawData(data: UnknownRecord): ProfileIdentifiers[] {
	return [
		identifiersFromProfile(
			firstValue(data, "SkullOwner", "skull_owner", "skullOwner", "Owner", "owner")
		),
		identifiersFromProfile(firstValue(data, "profile", "Profile")),
	];
}

type ProfileReference = {
	identifier: string | null;
	fallbackIdentifier: string | null;
};

function profileReferenceFromRawNbt(nbt: UnknownRecord): ProfileReference {
	const wrappedData = firstRecord(nbt, "Data", "data");
	const identifiers = [
		...(wrappedData === null ? [] : profileIdentifiersFromRawData(wrappedData)),
		...profileIdentifiersFromRawData(nbt),
	];
	const uuid = identifiers.find((entry) => entry.uuid !== null)?.uuid ?? null;
	const name = identifiers.find((entry) => entry.name !== null)?.name ?? null;
	return uuid === null
		? { identifier: name, fallbackIdentifier: null }
		: { identifier: uuid, fallbackIdentifier: name };
}

function legacyPositionFromRecord(record: UnknownRecord): Position | null {
	for (const key of ["pos", "Position", "position"]) {
		const position = parsePosition(record[key]);
		if (position !== null) return position;
	}
	const coordinates = ["x", "y", "z"].map((key) => record[key]);
	return coordinates.every(Number.isSafeInteger)
		? [Number(coordinates[0]), Number(coordinates[1]), Number(coordinates[2])]
		: null;
}

function legacyPositionFromNbt(nbt: UnknownRecord): Position | null {
	const direct = legacyPositionFromRecord(nbt);
	if (direct !== null) return direct;
	const data = firstRecord(nbt, "Data", "data");
	if (data === null) return null;
	return parsePosition(data.Pos) ?? legacyPositionFromRecord(data);
}

function parsePlayerHeadCandidate(value: unknown): PlayerHeadCandidate | null {
	const entity = asRecord(value);
	if (entity === null) return null;
	const nbt = asRecord(entity.nbt) ?? asRecord(entity.NBT) ?? entity;
	const nbtPosition = parsePosition(nbt.Pos);
	const outerPosition = parsePosition(entity.position) ?? nbtPosition ?? legacyPositionFromNbt(nbt);
	if (outerPosition === null) return null;
	if (
		nbt.Pos !== undefined &&
		(nbtPosition === null || !samePosition(outerPosition, nbtPosition))
	) {
		return null;
	}
	// Nucleation 0.2.x exposes legacy lower-case `pos` entities at [0,0,0].
	// Recover their source position; palette verification later prevents an NBT
	// record from creating a head where no player-head block exists.
	const position = nbtPosition ?? legacyPositionFromNbt(nbt) ?? outerPosition;

	const canonicalHash =
		firstString(nbt, "CoastlineStudioTextureHash") ?? firstString(nbt, "SchematicHubTextureHash");
	if (
		canonicalHash !== null &&
		HEAD_TEXTURE_HASH_PATTERN.test(canonicalHash) &&
		(entity.id !== SANITIZED_PLAYER_HEAD_ID ||
			nbt.Id === undefined ||
			nbt.Id === SANITIZED_PLAYER_HEAD_ID)
	) {
		return {
			position,
			textureHash: canonicalHash,
			profileIdentifier: null,
			profileFallbackIdentifier: null,
		};
	}

	if (entity.id === SANITIZED_PLAYER_HEAD_ID) {
		// Nucleation exposes Id/Pos on the outer entity and removes them from the
		// inner nbt object. Accept nbt.Id when an older wrapper retains it, but do
		// not require the duplicate field.
		if (nbt.Id !== undefined && nbt.Id !== SANITIZED_PLAYER_HEAD_ID) return null;
		const textureHash = firstString(nbt, "TextureHash");
		return {
			position,
			textureHash:
				textureHash !== null && HEAD_TEXTURE_HASH_PATTERN.test(textureHash) ? textureHash : null,
			profileIdentifier: null,
			profileFallbackIdentifier: null,
		};
	}

	const textureHash = textureHashFromRawNbt(nbt);
	const profile =
		textureHash === null
			? profileReferenceFromRawNbt(nbt)
			: { identifier: null, fallbackIdentifier: null };
	return {
		position,
		textureHash,
		profileIdentifier: profile.identifier,
		profileFallbackIdentifier: profile.fallbackIdentifier,
	};
}

/**
 * Reads either the former sanitized v2 marker or bounded player-head fields from
 * raw Sponge v2/v3 block entities. Raw profile data is reduced to a canonical
 * texture hash, UUID, or username without requesting remote profile data.
 * Raw block-entity IDs are not authoritative; selectCustomPlayerHeads verifies
 * the block state at the position.
 */
export function parseSanitizedPlayerHead(value: unknown): SanitizedPlayerHead | null {
	const candidate = parsePlayerHeadCandidate(value);
	return candidate?.textureHash === null || candidate === null
		? null
		: {
				position: candidate.position,
				textureHash: candidate.textureHash,
			};
}

export function resolveCustomPlayerHead(
	head: PlayerHeadCandidate,
	block: HeadBlockState | null
): CustomPlayerHead | null {
	if (block?.name === "minecraft:player_head") {
		const parsedRotation = Number(block.properties.rotation);
		const rotation =
			Number.isInteger(parsedRotation) && parsedRotation >= 0 && parsedRotation <= 15
				? parsedRotation
				: 0;
		return {
			...head,
			// Cubane centers every block at its integer coordinate. Minecraft model
			// coordinates use a 0..1 cell, so the standing head center
			// (0.5, 0.25, 0.5) becomes (0, -0.25, 0).
			offset: [0, -0.25, 0],
			rotationY: (-rotation * Math.PI) / 8,
		};
	}

	if (block?.name !== "minecraft:player_wall_head") return null;
	switch (block.properties.facing) {
		case "north":
			return { ...head, offset: [0, 0, 0.25], rotationY: Math.PI };
		case "south":
			return { ...head, offset: [0, 0, -0.25], rotationY: 0 };
		case "west":
			return { ...head, offset: [0.25, 0, 0], rotationY: -Math.PI / 2 };
		case "east":
			return { ...head, offset: [-0.25, 0, 0], rotationY: Math.PI / 2 };
		default:
			return null;
	}
}

export function selectCustomPlayerHeads(
	entities: unknown,
	getBlockState: (position: Position) => HeadBlockState | null
): CustomPlayerHead[] {
	if (!Array.isArray(entities)) return [];

	const heads: CustomPlayerHead[] = [];
	const positions = new Set<string>();
	const inspectionCount = Math.min(entities.length, MAX_CUSTOM_HEAD_ENTITIES_INSPECTED);

	for (let index = 0; index < inspectionCount && heads.length < MAX_CUSTOM_PLAYER_HEADS; index++) {
		const parsedCandidate = parsePlayerHeadCandidate(entities[index]);
		if (parsedCandidate === null) continue;

		const positionKey = parsedCandidate.position.join(",");
		if (positions.has(positionKey)) continue;
		const candidate = parsedCandidate;
		const head = resolveCustomPlayerHead(candidate, getBlockState(candidate.position));
		if (head === null) continue;
		positions.add(positionKey);
		heads.push(head);
	}

	return heads;
}

function playerHeadStatesFromPalette(palette: unknown) {
	const states = new Map<number, HeadBlockState>();
	if (!Array.isArray(palette)) return states;
	palette.forEach((value, index) => {
		const state = parsePaletteBlockState(value);
		if (state?.name === "minecraft:player_head" || state?.name === "minecraft:player_wall_head") {
			states.set(index, state);
		}
	});
	return states;
}

function blockEntityCandidatesByPosition(entities: unknown) {
	const candidates = new Map<string, PlayerHeadCandidate>();
	if (!Array.isArray(entities)) return candidates;
	const inspectionCount = Math.min(entities.length, MAX_CUSTOM_HEAD_ENTITIES_INSPECTED);
	for (let index = 0; index < inspectionCount; index += 1) {
		const candidate = parsePlayerHeadCandidate(entities[index]);
		if (candidate === null) continue;
		const key = candidate.position.join(",");
		const previous = candidates.get(key);
		if (
			previous === undefined ||
			(previous.textureHash === null &&
				(candidate.textureHash !== null || previous.profileIdentifier === null))
		) {
			candidates.set(key, candidate);
		}
	}
	return candidates;
}

/**
 * Finds heads from block positions first, then joins block-entity NBT by position.
 * This avoids relying on Schem-at's batch block-entity path, which can omit NBT
 * from chunk meshes. A head remains textured with the default player skin when
 * NBT or its remote texture is unavailable.
 */
export function selectCustomPlayerHeadsFromSchematic(
	wrapper: HeadSchematicWrapper,
	snapshot?: BlockEntitySnapshot
): CustomPlayerHead[] {
	let palette = snapshot?.palette;
	let blocks = snapshot?.blocks;
	let entities = snapshot?.entities;
	if (snapshot === undefined) {
		try {
			palette = wrapper.get_palette?.();
			blocks = wrapper.blocks_indices?.();
			entities = wrapper.get_all_block_entities?.();
		} catch (error) {
			console.warn("[schematic-renderer] Player head block scan failed.", error);
		}
	}

	const headStates = playerHeadStatesFromPalette(palette);
	if (!Array.isArray(blocks) || headStates.size === 0) {
		return selectCustomPlayerHeads(entities, (position) => readBlockState(wrapper, position));
	}

	const batchCandidates = blockEntityCandidatesByPosition(entities);
	const heads: CustomPlayerHead[] = [];
	const positions = new Set<string>();
	const inspectionCount = Math.min(blocks.length, MAX_CUSTOM_HEAD_BLOCKS_INSPECTED);

	for (let index = 0; index < inspectionCount && heads.length < MAX_CUSTOM_PLAYER_HEADS; index++) {
		const row = parseIndexedSchematicBlock(blocks[index]);
		if (row === null) continue;
		const state = headStates.get(row.paletteIndex);
		if (state === undefined) continue;

		const position = row.position;
		const positionKey = position.join(",");
		if (positions.has(positionKey)) continue;

		let candidate = batchCandidates.get(positionKey);
		if (candidate === undefined || candidate.textureHash === null) {
			try {
				const direct = parsePlayerHeadCandidate(
					wrapper.get_block_entity?.(position[0], position[1], position[2])
				);
				if (direct !== null && samePosition(direct.position, position)) {
					candidate =
						direct.textureHash !== null ||
						(candidate?.profileIdentifier === null && direct.profileIdentifier !== null) ||
						candidate === undefined
							? direct
							: candidate;
				}
			} catch {
				// Batch NBT or the default player-skin fallback still renders this head.
			}
		}

		const textureHash = candidate?.textureHash ?? null;
		const profileIdentifier = textureHash === null ? (candidate?.profileIdentifier ?? null) : null;
		const profileFallbackIdentifier =
			profileIdentifier === null ? null : (candidate?.profileFallbackIdentifier ?? null);

		const head = resolveCustomPlayerHead(
			{
				position,
				textureHash,
				profileIdentifier,
				profileFallbackIdentifier,
			},
			state
		);
		if (head === null) continue;

		positions.add(positionKey);
		heads.push(head);
	}

	return heads;
}

function applySkinUvs(geometry: BoxGeometry, hatLayer: boolean, legacyLayout: boolean) {
	const rectangles = hatLayer ? HAT_UV_RECTS : BASE_UV_RECTS;
	const uv = geometry.getAttribute("uv");
	const textureHeight = legacyLayout ? 32 : 64;

	rectangles.forEach(([left, top, right, bottom], faceIndex) => {
		const vertex = faceIndex * 4;
		const u0 = left / 64;
		const u1 = right / 64;
		const v0 = 1 - top / textureHeight;
		const v1 = 1 - bottom / textureHeight;
		// BoxGeometry's -Y plane is wound in the opposite vertical direction.
		const firstV = faceIndex === 3 ? v1 : v0;
		const secondV = faceIndex === 3 ? v0 : v1;
		uv.setXY(vertex, u0, firstV);
		uv.setXY(vertex + 1, u1, firstV);
		uv.setXY(vertex + 2, u0, secondV);
		uv.setXY(vertex + 3, u1, secondV);
	});
	uv.needsUpdate = true;
}

export function createMinecraftHeadGeometry(hatLayer = false, legacyLayout = false): BoxGeometry {
	const size = hatLayer ? 9 / 16 : 0.5;
	const geometry = new BoxGeometry(size, size, size);
	applySkinUvs(geometry, hatLayer, legacyLayout);
	return geometry;
}

function validSkinDimensions(width: number, height: number) {
	return (
		width >= 64 && width <= 1024 && width % 64 === 0 && (height === width || height * 2 === width)
	);
}

/**
 * Mirrors Minecraft's "Notch transparency hack" for legacy skins. If the
 * legacy-only right half has no meaningful alpha, Minecraft treats that whole
 * half as transparent. Without this conversion, old skins such as Notch's
 * render their opaque black headwear matte as a cube around the real head.
 */
export function applyLegacyNotchTransparencyHack(
	pixels: Uint8ClampedArray,
	width: number,
	height: number
) {
	if (
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width < 64 ||
		width % 64 !== 0 ||
		height * 2 !== width ||
		pixels.length !== width * height * 4
	) {
		return false;
	}

	const startX = width / 2;
	for (let y = 0; y < height; y += 1) {
		for (let x = startX; x < width; x += 1) {
			const alphaOffset = (y * width + x) * 4 + 3;
			const alpha = pixels[alphaOffset];
			if (alpha !== undefined && alpha < 128) {
				return false;
			}
		}
	}

	for (let y = 0; y < height; y += 1) {
		for (let x = startX; x < width; x += 1) {
			pixels[(y * width + x) * 4 + 3] = 0;
		}
	}
	return true;
}

type SkinImage = ImageBitmap | HTMLImageElement;
type SkinCanvas = OffscreenCanvas | HTMLCanvasElement;
type SkinCanvasContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function createSkinCanvas(
	width: number,
	height: number
): { canvas: SkinCanvas; context: SkinCanvasContext } | null {
	try {
		if (typeof OffscreenCanvas !== "undefined") {
			const canvas = new OffscreenCanvas(width, height);
			const context = canvas.getContext("2d", { willReadFrequently: true });
			if (context !== null) return { canvas, context };
		}
	} catch {
		// Fall through to the DOM canvas implementation.
	}
	try {
		if (typeof document !== "undefined") {
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext("2d", { willReadFrequently: true });
			if (context !== null) return { canvas, context };
		}
	} catch {
		// The original decoded image remains a valid texture fallback.
	}
	return null;
}

function normalizeLegacySkinSource(image: SkinImage): SkinImage | SkinCanvas {
	const surface = createSkinCanvas(image.width, image.height);
	if (surface === null) return image;

	try {
		surface.context.imageSmoothingEnabled = false;
		surface.context.drawImage(image, 0, 0);
		const imageData = surface.context.getImageData(0, 0, image.width, image.height);
		if (!applyLegacyNotchTransparencyHack(imageData.data, image.width, image.height)) {
			return image;
		}
		surface.context.putImageData(imageData, 0, 0);
		return surface.canvas;
	} catch {
		return image;
	}
}

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	return reason instanceof Error ? reason : new DOMException("Aborted", "AbortError");
}

async function imageElementFromBlob(blob: Blob, signal: AbortSignal) {
	if (signal.aborted) {
		throw abortError(signal);
	}
	const objectUrl = URL.createObjectURL(blob);
	try {
		const image = new Image();
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				image.removeEventListener("load", load);
				image.removeEventListener("error", fail);
				signal.removeEventListener("abort", abort);
			};
			const load = () => {
				cleanup();
				resolve();
			};
			const fail = () => {
				cleanup();
				reject(new Error("Head texture decode failed"));
			};
			const abort = () => {
				cleanup();
				image.src = "";
				reject(abortError(signal));
			};
			image.addEventListener("load", load, { once: true });
			image.addEventListener("error", fail, { once: true });
			signal.addEventListener("abort", abort, { once: true });
			image.src = objectUrl;
		});
		return image;
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}

async function cancelResponseBody(response: Response) {
	try {
		await response.body?.cancel();
	} catch {
		// Body may already be locked or closed. The texture request still fails safely.
	}
}

async function loadHeadTexture(
	request: HeadTextureRequest,
	signal: AbortSignal
): Promise<LoadedTexture> {
	const init: RequestInit = {
		cache: request.cache ?? "force-cache",
		credentials: request.credentials ?? "same-origin",
		headers: { accept: "image/png" },
		signal,
	};
	let response = await fetch(request.url, init);
	if (response.status === 404 && request.fallbackUrl != null) {
		await cancelResponseBody(response);
		response = await fetch(request.fallbackUrl, init);
	}
	if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0] !== "image/png") {
		throw new Error(`Head texture returned HTTP ${response.status}`);
	}

	const rawContentLength = response.headers.get("content-length")?.trim();
	if (rawContentLength !== undefined && /^\d+$/.test(rawContentLength)) {
		const contentLength = Number(rawContentLength);
		if (contentLength > MAX_HEAD_TEXTURE_BYTES) {
			await cancelResponseBody(response);
			throw new Error("Head texture Content-Length exceeds the byte limit");
		}
	}
	const blob = await response.blob();
	if (blob.size === 0 || blob.size > MAX_HEAD_TEXTURE_BYTES) {
		throw new Error("Head texture has an invalid byte length");
	}

	let image: ImageBitmap | HTMLImageElement;
	let closeImage: () => void = () => undefined;
	let flipY = true;
	if ("createImageBitmap" in globalThis) {
		try {
			const bitmap = await createImageBitmap(blob, {
				colorSpaceConversion: "none",
				imageOrientation: "flipY",
				premultiplyAlpha: "none",
			});
			if (signal.aborted) {
				bitmap.close();
				throw abortError(signal);
			}
			image = bitmap;
			closeImage = () => bitmap.close();
			flipY = false;
		} catch (error) {
			if (signal.aborted) throw error;
			image = await imageElementFromBlob(blob, signal);
		}
	} else {
		image = await imageElementFromBlob(blob, signal);
	}

	if (!validSkinDimensions(image.width, image.height)) {
		closeImage();
		throw new Error("Head texture dimensions are invalid");
	}

	const legacyLayout = image.height * 2 === image.width;
	const textureSource = legacyLayout ? normalizeLegacySkinSource(image) : image;
	if (textureSource !== image) {
		closeImage();
		closeImage = () => undefined;
	}
	const texture = new Texture(textureSource);
	// Schem-at applies its own gamma post-processing and marks its entity
	// textures as linear. Match that pipeline or skins are gamma-corrected
	// twice and render almost black.
	texture.colorSpace = LinearSRGBColorSpace;
	texture.flipY = flipY;
	texture.magFilter = NearestFilter;
	texture.minFilter = NearestFilter;
	// A player skin is a sparse pixel atlas. Generated mipmaps bleed transparent
	// atlas padding into the tiny face regions.
	texture.generateMipmaps = false;
	texture.needsUpdate = true;
	return {
		texture,
		legacyLayout,
		closeImage,
	};
}

async function loadTextures(
	requests: HeadTextureRequest[],
	parentSignal: AbortSignal
): Promise<Map<string, LoadedTexture>> {
	const loaded = new Map<string, LoadedTexture>();
	const loadController = new AbortController();
	const abortFromParent = () => loadController.abort(abortError(parentSignal));
	parentSignal.addEventListener("abort", abortFromParent, { once: true });
	if (parentSignal.aborted) abortFromParent();
	const budgetTimeout = globalThis.setTimeout(() => {
		loadController.abort(new DOMException("Head texture load budget exceeded", "TimeoutError"));
	}, CUSTOM_HEAD_TEXTURE_LOAD_BUDGET_MS);
	const signal = loadController.signal;
	let nextIndex = 0;

	async function worker() {
		while (!signal.aborted) {
			const index = nextIndex++;
			if (index >= requests.length) return;
			const request = requests[index];
			if (request === undefined) return;
			try {
				loaded.set(request.key, await loadHeadTexture(request, signal));
			} catch (error) {
				if (!signal.aborted) {
					console.warn(
						`[schematic-renderer] Head texture ${request.description ?? request.key} was skipped.`,
						error
					);
				}
			}
		}
	}

	try {
		await Promise.all(
			Array.from({ length: Math.min(CUSTOM_HEAD_TEXTURE_CONCURRENCY, requests.length) }, () =>
				worker()
			)
		);
		return loaded;
	} finally {
		globalThis.clearTimeout(budgetTimeout);
		parentSignal.removeEventListener("abort", abortFromParent);
	}
}

async function loadResourcePackHeadTexture(
	resources: BlockEntityResources,
	signal: AbortSignal
): Promise<LoadedTexture | null> {
	for (const path of DEFAULT_HEAD_TEXTURE_PATHS) {
		if (signal.aborted) return null;
		try {
			const source = await resources.getTexture(path);
			if (signal.aborted) return null;
			const dimensions = asRecord(source.image as unknown);
			const width = Number(dimensions?.width);
			const height = Number(dimensions?.height);
			if (!validSkinDimensions(width, height)) continue;
			const texture = source.clone();
			if (height * 2 === width)
				texture.image = normalizeLegacySkinSource(source.image as SkinImage);
			texture.colorSpace = LinearSRGBColorSpace;
			texture.magFilter = NearestFilter;
			texture.minFilter = NearestFilter;
			texture.generateMipmaps = false;
			texture.needsUpdate = true;
			return { texture, legacyLayout: height * 2 === width, closeImage: () => undefined };
		} catch {
			// Older packs use entity/steve; missing textures retain the solid fallback.
		}
	}
	return null;
}

function readBlockState(wrapper: HeadSchematicWrapper, position: Position): HeadBlockState | null {
	const [x, y, z] = position;
	let block:
		| {
				name?: (() => string) | string;
				properties?: (() => unknown) | UnknownRecord;
				free?: () => void;
		  }
		| null
		| undefined;
	try {
		block = wrapper.get_block_with_properties?.(x, y, z) as typeof block;
	} catch {
		block = undefined;
	}

	if (block == null) {
		try {
			const name = wrapper.get_block?.(x, y, z);
			return parsePaletteBlockState(name);
		} catch {
			return null;
		}
	}

	try {
		const name = typeof block.name === "function" ? block.name() : block.name;
		const rawProperties =
			typeof block.properties === "function" ? block.properties() : block.properties;
		return parsePaletteBlockState({ name, properties: rawProperties });
	} catch {
		return null;
	} finally {
		block.free?.();
	}
}

function emptyOverlay(): CustomPlayerHeadOverlay {
	return { count: 0, dispose: () => undefined };
}

/**
 * Loads and attaches custom heads to the schematic group. Texture failures use
 * the configured default or resource-pack player skin so missing remote data never removes
 * the block. Every created instanced mesh and shared GPU resource is disposable.
 */
export async function createCustomPlayerHeadOverlay(
	schematic: CustomHeadSchematic,
	signal: AbortSignal,
	snapshot?: BlockEntitySnapshot,
	resources?: BlockEntityResources,
	options: PlayerHeadOptions = {}
): Promise<CustomPlayerHeadOverlay> {
	const heads = selectCustomPlayerHeadsFromSchematic(schematic.schematicWrapper, snapshot);
	if (heads.length === 0 || signal.aborted) return emptyOverlay();

	const textureRequests = new Map<string, HeadTextureRequest>();
	if (options.defaultTextureUrl !== undefined) {
		textureRequests.set(DEFAULT_HEAD_TEXTURE_KEY, {
			key: DEFAULT_HEAD_TEXTURE_KEY,
			url: options.defaultTextureUrl,
			cache: "force-cache",
			description: "default player skin",
		});
	}
	const requestKeys = new Map<CustomPlayerHead, string>();
	const resolvedRequests = new Map<string, string | null>();
	for (const head of heads) {
		if (head.textureHash === null && head.profileIdentifier === null) continue;
		const identity =
			head.textureHash !== null
				? `texture:${head.textureHash}`
				: `profile:${head.profileIdentifier}:${head.profileFallbackIdentifier ?? ""}`;
		let key = resolvedRequests.get(identity);
		if (key === undefined) {
			const request = options.resolveTexture?.(head) ?? null;
			key = null;
			// Reserve the default key; fallback must remain deterministic even if a resolver mislabels a request.
			if (
				request !== null &&
				request.key !== DEFAULT_HEAD_TEXTURE_KEY &&
				(textureRequests.has(request.key) ||
					textureRequests.size - Number(textureRequests.has(DEFAULT_HEAD_TEXTURE_KEY)) <
						MAX_CUSTOM_HEAD_TEXTURES)
			) {
				textureRequests.set(request.key, request);
				key = request.key;
			}
			resolvedRequests.set(identity, key);
		}
		if (key !== null) requestKeys.set(head, key);
	}

	const [loadedTextures, defaultTexture] = await Promise.all([
		loadTextures([...textureRequests.values()], signal),
		options.defaultTextureUrl === undefined && resources !== undefined
			? loadResourcePackHeadTexture(resources, signal)
			: Promise.resolve(null),
	]);
	if (defaultTexture !== null) loadedTextures.set(DEFAULT_HEAD_TEXTURE_KEY, defaultTexture);
	if (signal.aborted) {
		for (const loaded of loadedTextures.values()) {
			loaded.texture.dispose();
			loaded.closeImage();
		}
		return emptyOverlay();
	}

	const geometries = {
		modern: {
			base: createMinecraftHeadGeometry(),
			hat: createMinecraftHeadGeometry(true),
		},
		legacy: {
			base: createMinecraftHeadGeometry(false, true),
			hat: createMinecraftHeadGeometry(true, true),
		},
	};
	const materials = new Map<string, MaterialPair>();
	const overlay = new Group();
	const meshes: InstancedMesh[] = [];
	overlay.name = "schematic-renderer:custom-player-heads";
	const headsByTexture = new Map<string, CustomPlayerHead[]>();
	for (const head of heads) {
		const requestKey = requestKeys.get(head) ?? null;
		const materialKey =
			requestKey !== null && loadedTextures.has(requestKey)
				? requestKey
				: loadedTextures.has(DEFAULT_HEAD_TEXTURE_KEY)
					? DEFAULT_HEAD_TEXTURE_KEY
					: FALLBACK_HEAD_MATERIAL_KEY;
		const textureHeads = headsByTexture.get(materialKey);
		if (textureHeads === undefined) {
			headsByTexture.set(materialKey, [head]);
		} else {
			textureHeads.push(head);
		}
	}
	const position = new Vector3();
	const rotation = new Quaternion();
	const scale = new Vector3(1, 1, 1);
	const up = new Vector3(0, 1, 0);
	const matrix = new Matrix4();

	for (const [textureKey, textureHeads] of headsByTexture) {
		const loaded = loadedTextures.get(textureKey);
		let pair = materials.get(textureKey);
		if (pair === undefined) {
			pair =
				loaded === undefined
					? {
							base: new MeshLambertMaterial({
								color: 0xd69a72,
								depthTest: true,
								depthWrite: true,
								name: FALLBACK_HEAD_MATERIAL_KEY,
							}),
							hat: null,
						}
					: {
							base: new MeshLambertMaterial({
								depthTest: true,
								depthWrite: true,
								map: loaded.texture,
							}),
							hat: new MeshLambertMaterial({
								alphaTest: 1 / 255,
								depthTest: true,
								depthWrite: true,
								map: loaded.texture,
								side: DoubleSide,
								transparent: true,
							}),
						};
			materials.set(textureKey, pair);
		}

		const geometry = loaded?.legacyLayout ? geometries.legacy : geometries.modern;
		const base = new InstancedMesh(geometry.base, pair.base, textureHeads.length);
		meshes.push(base);
		base.name = `schematic-renderer:custom-player-head-base:${textureKey}`;
		base.instanceMatrix.setUsage(StaticDrawUsage);
		const hat =
			pair.hat === null ? null : new InstancedMesh(geometry.hat, pair.hat, textureHeads.length);
		if (hat !== null) {
			meshes.push(hat);
			hat.name = `schematic-renderer:custom-player-head-hat:${textureKey}`;
			hat.instanceMatrix.setUsage(StaticDrawUsage);
		}

		textureHeads.forEach((head, index) => {
			position.set(
				head.position[0] + head.offset[0],
				head.position[1] + head.offset[1],
				head.position[2] + head.offset[2]
			);
			rotation.setFromAxisAngle(up, head.rotationY);
			matrix.compose(position, rotation, scale);
			base.setMatrixAt(index, matrix);
			hat?.setMatrixAt(index, matrix);
		});
		base.instanceMatrix.needsUpdate = true;
		base.computeBoundingBox();
		base.computeBoundingSphere();
		base.castShadow = true;
		base.receiveShadow = true;
		overlay.add(base);
		if (hat !== null) {
			hat.instanceMatrix.needsUpdate = true;
			hat.computeBoundingBox();
			hat.computeBoundingSphere();
			hat.castShadow = true;
			hat.receiveShadow = true;
			overlay.add(hat);
		}
	}

	schematic.group.add(overlay);
	let disposed = false;
	return {
		count: heads.length,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			schematic.group.remove(overlay);
			overlay.clear();
			for (const mesh of meshes) mesh.dispose();
			geometries.modern.base.dispose();
			geometries.modern.hat.dispose();
			geometries.legacy.base.dispose();
			geometries.legacy.hat.dispose();
			for (const pair of materials.values()) {
				pair.base.dispose();
				pair.hat?.dispose();
			}
			for (const loaded of loadedTextures.values()) {
				loaded.texture.dispose();
				loaded.closeImage();
			}
		},
	};
}
