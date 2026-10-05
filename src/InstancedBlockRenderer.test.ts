import { describe, expect, it, vi } from "vitest";
import { BoxGeometry, Group, MeshBasicMaterial, Vector3, Matrix4 } from "three";
import { InstancedBlockRenderer } from "./InstancedBlockRenderer";
import type { PaletteCache } from "./types";

vi.mock("./WorldMeshBuilder", () => ({ INVISIBLE_BLOCKS: new Set(["minecraft:air"]) }));

describe("InstancedBlockRenderer variants", () => {
	it("keeps instances with different blockstate properties in their matching meshes", () => {
		const group = new Group();
		const material = new MeshBasicMaterial();
		const northGeometry = new BoxGeometry(1, 1, 0.5);
		const eastGeometry = new BoxGeometry(0.5, 1, 1);
		const palette: PaletteCache = {
			isReady: true,
			palette: [
				{ name: "minecraft:oak_stairs", properties: { facing: "north" } },
				{ name: "minecraft:oak_stairs", properties: { facing: "east" } },
			],
			globalMaterials: [material],
			blockData: [northGeometry, eastGeometry].map((baseGeometry) => ({
				blockName: "minecraft:oak_stairs",
				category: "solid",
				materialGroups: [{ baseGeometry, material, materialIndex: 0, positions: [] }],
			})),
		};
		const renderer = new InstancedBlockRenderer(group, palette);
		renderer.initializeInstancedMeshes();
		renderer.renderBlocksInstanced([
			{ x: 1, y: 2, z: 3, paletteIndex: 0 },
			{ x: 4, y: 5, z: 6, paletteIndex: 1 },
		]);
		const north = renderer.getInstancedMeshes("minecraft:oak_stairs[facing=north]")[0];
		const east = renderer.getInstancedMeshes("minecraft:oak_stairs[facing=east]")[0];
		expect(north.geometry).toBe(northGeometry);
		expect(east.geometry).toBe(eastGeometry);
		expect(north.count).toBe(1);
		expect(east.count).toBe(1);
		const transform = new Matrix4();
		east.getMatrixAt(0, transform);
		expect(new Vector3().setFromMatrixPosition(transform).toArray()).toEqual([4, 5, 6]);
		renderer.disposeInstancedMeshes();
		northGeometry.dispose();
		eastGeometry.dispose();
		material.dispose();
	});
});
