import { describe, expect, it } from "vitest";
import { BufferGeometry, MeshBasicMaterial } from "three";
import type { BlockOptimizationData, OptimizedFace } from "../../cubane/types";
import { getBlockOcclusionFlags, rotateOcclusionFlags } from "../occlusion";

function model(
	direction: string,
	material = new MeshBasicMaterial(),
	bounds: [number[], number[]] = [
		[0, 0, 0],
		[16, 16, 16],
	]
): BlockOptimizationData {
	const face: OptimizedFace = {
		geometry: new BufferGeometry(),
		material,
		direction,
		elementBounds: bounds,
		canBatch: true,
	};
	return {
		isCube: true,
		hasTransparency: material.transparent,
		hasCullableFaces: true,
		cullableFaces: new Map([[direction, [face]]]),
		nonCullableFaces: [],
	};
}

describe("model occlusion", () => {
	it("rotates top stairs and horizontal blockstate faces into world directions", () => {
		expect(rotateOcclusionFlags(1 << 2, { x: 180 })).toBe(1 << 3);
		expect(rotateOcclusionFlags(1 << 4, { y: 90 })).toBe(1 << 1);
		expect(rotateOcclusionFlags(1 << 3, { x: 90, y: 90 })).toBe(1 << 1);
		expect(rotateOcclusionFlags(63, { x: 270, y: -90 })).toBe(63);
	});
	it("never guesses occlusion for unsupported rotations", () => {
		expect(rotateOcclusionFlags(63, { x: 45 })).toBe(0);
		expect(rotateOcclusionFlags(63, { y: Infinity })).toBe(0);
	});
	it("keeps neighbouring blocks visible through cutout trapdoors and translucent faces", () => {
		expect(getBlockOcclusionFlags(model("up", new MeshBasicMaterial({ alphaTest: 0.01 })))).toBe(0);
		expect(getBlockOcclusionFlags(model("up", new MeshBasicMaterial({ transparent: true })))).toBe(
			0
		);
		expect(getBlockOcclusionFlags(model("up"))).toBe(1 << 3);
	});
	it("only occludes a full boundary face, preserving faces behind slabs", () => {
		const slab = model("up", undefined, [
			[0, 0, 0],
			[16, 8, 16],
		]);
		expect(getBlockOcclusionFlags(slab)).toBe(0);
		const stairs = model("down");
		stairs.modelRotation = { x: 180, y: 0 };
		expect(getBlockOcclusionFlags(stairs)).toBe(1 << 3);
		expect(
			getBlockOcclusionFlags(
				model("west", undefined, [
					[0, 0, 0],
					[16, 8, 16],
				])
			)
		).toBe(0);
	});
});
