import type { Group, Object3D, Texture } from "three";

export type SchematicPosition = readonly [number, number, number];

export type BlockEntityBlockState = {
	name: string;
	properties: Record<string, string>;
};

export type BlockEntitySchematicWrapper = {
	get_all_block_entities?: () => unknown;
	get_block_entity?: (x: number, y: number, z: number) => unknown;
	get_palette?: () => unknown;
	blocks_indices?: () => unknown;
	get_block_with_properties?: (x: number, y: number, z: number) => unknown;
	get_block?: (x: number, y: number, z: number) => string | undefined;
};

export type BlockEntitySchematic = {
	group: Group;
	schematicWrapper: BlockEntitySchematicWrapper;
	/** Block coordinates; min inclusive, max exclusive. */
	renderingBounds?: {
		enabled?: boolean;
		min: { x: number; y: number; z: number };
		max: { x: number; y: number; z: number };
	};
};

export type BlockEntitySnapshot = {
	palette: unknown;
	blocks: unknown;
	entities: unknown;
};

export type BlockEntityResources = {
	getEntityMesh: (entityType: string, useCache?: boolean) => Promise<Object3D>;
	getTexture: (texturePath: string) => Promise<Texture>;
};

export type IndexedSchematicBlock = {
	position: SchematicPosition;
	paletteIndex: number;
};

export type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as UnknownRecord)
		: null;
}

export function parseSchematicPosition(value: unknown): SchematicPosition | null {
	const values = Array.isArray(value)
		? value
		: ArrayBuffer.isView(value)
			? Array.from(value as unknown as ArrayLike<number>)
			: null;
	if (
		values === null ||
		values.length !== 3 ||
		values.some((coordinate) => !Number.isSafeInteger(coordinate))
	) {
		return null;
	}
	return [Number(values[0]), Number(values[1]), Number(values[2])];
}

export function parseIndexedSchematicBlock(value: unknown): IndexedSchematicBlock | null {
	const values = Array.isArray(value)
		? value
		: ArrayBuffer.isView(value)
			? Array.from(value as unknown as ArrayLike<number>)
			: null;
	if (
		values === null ||
		values.length < 4 ||
		values.slice(0, 4).some((coordinate) => !Number.isSafeInteger(coordinate))
	) {
		return null;
	}
	return {
		position: [Number(values[0]), Number(values[1]), Number(values[2])],
		paletteIndex: Number(values[3]),
	};
}

export function parsePaletteBlockState(value: unknown): BlockEntityBlockState | null {
	if (typeof value === "string") {
		const propertyStart = value.indexOf("[");
		const name = value.slice(0, propertyStart < 0 ? undefined : propertyStart);
		const properties: Record<string, string> = {};
		if (propertyStart >= 0 && value.endsWith("]")) {
			for (const property of value.slice(propertyStart + 1, -1).split(",")) {
				const separator = property.indexOf("=");
				if (separator > 0) {
					properties[property.slice(0, separator)] = property.slice(separator + 1);
				}
			}
		}
		return name.length === 0 ? null : { name, properties };
	}

	const block = asRecord(value);
	if (block === null) return null;
	const rawName =
		typeof block.name === "string"
			? block.name
			: typeof block.Name === "string"
				? block.Name
				: null;
	if (rawName === null) return null;
	const rawProperties = asRecord(block.properties) ?? asRecord(block.Properties) ?? {};
	const properties = Object.fromEntries(
		Object.entries(rawProperties)
			.filter(
				(entry): entry is [string, string | number | boolean] =>
					typeof entry[1] === "string" ||
					typeof entry[1] === "number" ||
					typeof entry[1] === "boolean"
			)
			.map(([key, property]) => [key, String(property)])
	);
	const parsed = parsePaletteBlockState(rawName);
	return parsed === null
		? null
		: { name: parsed.name, properties: { ...parsed.properties, ...properties } };
}

function readSnapshotValue(label: string, reader: (() => unknown) | undefined): unknown {
	try {
		return reader?.();
	} catch (error) {
		console.warn(`[schematic-renderer] ${label} scan failed.`, error);
		return undefined;
	}
}

export function captureBlockEntitySnapshot(
	wrapper: BlockEntitySchematicWrapper
): BlockEntitySnapshot {
	return {
		palette: readSnapshotValue("Block palette", wrapper.get_palette?.bind(wrapper)),
		blocks: readSnapshotValue("Block index", wrapper.blocks_indices?.bind(wrapper)),
		entities: readSnapshotValue("Block entity", wrapper.get_all_block_entities?.bind(wrapper)),
	};
}

/** Read normalized wrappers and plain Sponge/vanilla block-entity positions. */
export function parseBlockEntityPosition(value: unknown): SchematicPosition | null {
	const entity = asRecord(value);
	if (entity === null) return null;
	const nbt = asRecord(entity.nbt) ?? asRecord(entity.NBT) ?? entity;
	const data = asRecord(nbt.Data) ?? asRecord(nbt.data);
	for (const record of [nbt, data, entity]) {
		if (record === null) continue;
		for (const key of ["Pos", "pos", "position"]) {
			const parsed = parseSchematicPosition(record[key]);
			if (parsed !== null) return parsed;
		}
		const parsed = parseSchematicPosition([record.x, record.y, record.z]);
		if (parsed !== null) return parsed;
	}
	return null;
}

export function filterBlockEntitySnapshot(
	snapshot: BlockEntitySnapshot,
	bounds: BlockEntitySchematic["renderingBounds"]
): BlockEntitySnapshot {
	if (!bounds?.enabled) return snapshot;
	const visible = (position: SchematicPosition | null) =>
		position !== null &&
		position[0] >= bounds.min.x &&
		position[0] < bounds.max.x &&
		position[1] >= bounds.min.y &&
		position[1] < bounds.max.y &&
		position[2] >= bounds.min.z &&
		position[2] < bounds.max.z;
	return {
		palette: snapshot.palette,
		blocks: Array.isArray(snapshot.blocks)
			? snapshot.blocks.filter((block: unknown) =>
					visible(parseIndexedSchematicBlock(block)?.position ?? null)
				)
			: snapshot.blocks,
		entities: Array.isArray(snapshot.entities)
			? snapshot.entities.filter((entity: unknown) => visible(parseBlockEntityPosition(entity)))
			: snapshot.entities,
	};
}
