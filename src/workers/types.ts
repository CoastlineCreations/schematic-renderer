import type { TypedArray } from "three";
import type { ChunkGeometryData } from "../types";

/** Structured-clone payload sent to the mesh workers. */
export interface PaletteGeometryData {
	index: number;
	category?: string;
	occlusionFlags: number;
	isCubic?: boolean;
	geometries: Array<{
		positions: TypedArray;
		normals?: TypedArray;
		uvs?: TypedArray;
		indices: TypedArray | null;
		materialIndex: number;
	}>;
}

export interface MeshBuildResult {
	meshes: ChunkGeometryData[];
	origin?: number[];
}

/** Block entities supplied by nucleation's chunk and schematic APIs. */
export interface MeshBlockEntity {
	position: number[];
	nbt?: Record<string, unknown>;
	[key: string]: unknown;
}
