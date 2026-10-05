import type { BlockOptimizationData } from "../cubane/types";

/** Worker face order: west, east, down, up, north, south. */
const DIRECTIONS = [
	[-1, 0, 0],
	[1, 0, 0],
	[0, -1, 0],
	[0, 1, 0],
	[0, 0, -1],
	[0, 0, 1],
] as const;
const FACE_BITS: Readonly<Record<string, number>> = {
	west: 0,
	east: 1,
	down: 2,
	up: 3,
	north: 4,
	south: 5,
};

/** Apply Minecraft's model X then Y rotations to the worker's face mask. */
export function rotateOcclusionFlags(
	flags: number,
	rotation: { x?: number; y?: number } = {}
): number {
	const x = rotation.x ?? 0;
	const y = rotation.y ?? 0;
	if (!Number.isFinite(x) || !Number.isFinite(y) || x % 90 !== 0 || y % 90 !== 0) return 0;
	const xTurns = (((x % 360) + 360) % 360) / 90;
	const yTurns = (((y % 360) + 360) % 360) / 90;
	let result = 0;
	for (let bit = 0; bit < DIRECTIONS.length; bit++) {
		if (!(flags & (1 << bit))) continue;
		let [dx, dy, dz]: [number, number, number] = [...DIRECTIONS[bit]];
		for (let turn = 0; turn < xTurns; turn++) [dy, dz] = [dz, -dy];
		for (let turn = 0; turn < yTurns; turn++) [dx, dz] = [-dz, dx];
		const target = DIRECTIONS.findIndex(([tx, ty, tz]) => tx === dx && ty === dy && tz === dz);
		if (target !== -1) result |= 1 << target;
	}
	return result;
}

/** Only complete opaque faces on a block boundary may hide their neighbours. */
export function getBlockOcclusionFlags(data: BlockOptimizationData | undefined): number {
	if (!data) return 0;
	let flags = 0;
	for (const [direction, faces] of data.cullableFaces) {
		const bit = FACE_BITS[direction];
		if (bit === undefined) continue;
		const fullOpaqueFace = faces.some((face) => {
			// Element bounds describe the original cuboid. A rotated face can leave
			// gaps at a boundary even when those unrotated bounds span a full block.
			if (face.hasElementRotation || face.direction !== direction) return false;
			const material = face.material;
			// Cutout textures include holes even when material opacity is one.
			if (material.transparent || material.opacity < 1 || material.alphaTest > 0) return false;
			const [min, max] = face.elementBounds;
			const normalAxis = Math.floor(bit / 2);
			const boundary = bit % 2 === 0 ? min[normalAxis] : max[normalAxis];
			if (Math.abs(boundary - (bit % 2 === 0 ? 0 : 16)) > 0.01) return false;
			return [0, 1, 2].every(
				(axis) => axis === normalAxis || (min[axis] <= 0.01 && max[axis] >= 15.99)
			);
		});
		if (fullOpaqueFace) flags |= 1 << bit;
	}
	return rotateOcclusionFlags(flags, data.modelRotation);
}
