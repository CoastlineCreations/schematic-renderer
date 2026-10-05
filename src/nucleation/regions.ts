import { getNucleation } from "./runtime";
import type { DefinitionRegion, SortStrategy } from "nucleation";
import type { SchematicWrapper } from "./SchematicWrapper";
import { NativeHandle } from "./NativeHandle";

export type RegionPosition = [number, number, number];
export interface RegionBox {
	min: RegionPosition;
	max: RegionPosition;
}

export class BlockPosition {
	constructor(
		public x: number,
		public y: number,
		public z: number
	) {}
	public free(): void {}
	public [Symbol.dispose](): void {}
}

function coordinates(position: BlockPosition | RegionPosition): RegionPosition {
	return Array.isArray(position) ? position : [position.x, position.y, position.z];
}

/** Preserves the existing fluent region API across Nucleation's Diplomat migration. */
export class DefinitionRegionWrapper extends NativeHandle<DefinitionRegion> {
	private schematic?: SchematicWrapper;
	private regionName?: string;

	constructor(
		native = getNucleation().DefinitionRegion.create(),
		schematic?: SchematicWrapper,
		regionName?: string
	) {
		super(native);
		this.schematic = schematic;
		this.regionName = regionName;
	}

	static fromNative(
		native: DefinitionRegion,
		schematic?: SchematicWrapper,
		regionName?: string
	): DefinitionRegionWrapper {
		return new DefinitionRegionWrapper(native, schematic, regionName);
	}

	static fromBounds(min: BlockPosition, max: BlockPosition): DefinitionRegionWrapper {
		return this.fromNative(
			getNucleation().DefinitionRegion.fromBounds(min.x, min.y, min.z, max.x, max.y, max.z)
		);
	}

	static fromPositions(positions: RegionPosition[]): DefinitionRegionWrapper {
		return this.fromNative(getNucleation().DefinitionRegion.fromPositions(positions.flat()));
	}

	static fromBoundingBoxes(boxes: RegionBox[]): DefinitionRegionWrapper {
		return this.fromNative(
			getNucleation().DefinitionRegion.fromBoundingBoxes(
				boxes.flatMap(({ min, max }) => [...min, ...max])
			)
		);
	}

	private sync(): this {
		if (this.schematic && this.regionName !== undefined)
			this.native.sync(this.schematic.native, this.regionName);
		return this;
	}

	private wrap(native: DefinitionRegion): DefinitionRegionWrapper {
		return DefinitionRegionWrapper.fromNative(native, this.schematic);
	}

	public addBounds(min: BlockPosition | RegionPosition, max: BlockPosition | RegionPosition): this {
		this.native.addBounds(...coordinates(min), ...coordinates(max));
		return this.sync();
	}
	public addPoint(x: number, y: number, z: number): this {
		this.native.addPoint(x, y, z);
		return this.sync();
	}
	public addFilter(filter: string): this {
		this.native.addFilter(filter);
		return this.sync();
	}
	public setMetadata(key: string, value: string): this {
		this.native.setMetadata(key, value);
		return this.sync();
	}
	public withMetadata(key: string, value: string): this {
		return this.setMetadata(key, value);
	}
	public getMetadata(key: string): string | null {
		const metadata = this.getAllMetadata();
		return Object.prototype.hasOwnProperty.call(metadata, key) ? metadata[key] : null;
	}
	public getAllMetadata(): Record<string, string> {
		return JSON.parse(this.native.allMetadataJson());
	}
	public metadataKeys(): string[] {
		return JSON.parse(this.native.metadataKeysJson());
	}
	public setColor(color: number): this {
		this.native.setColor(color);
		return this.sync();
	}
	public isEmpty(): boolean {
		return Boolean(this.native.isEmpty());
	}
	public volume(): number {
		return Number(this.native.volume());
	}
	public contains(x: number, y: number, z: number): boolean {
		return Boolean(this.native.contains(x, y, z));
	}
	public isContiguous(): boolean {
		return Boolean(this.native.isContiguous());
	}
	public connectedComponents(): number {
		return this.native.connectedComponents();
	}
	public boxCount(): number {
		return this.native.boxCount();
	}
	public getBounds(): RegionBox | null {
		if (this.native.isEmpty()) return null;
		const bounds = this.native.bounds();
		return {
			min: [bounds.minX, bounds.minY, bounds.minZ],
			max: [bounds.maxX, bounds.maxY, bounds.maxZ],
		};
	}
	public getBox(index: number): RegionBox | null {
		if (index < 0 || index >= this.boxCount()) return null;
		const bounds = this.native.getBox(index);
		return {
			min: [bounds.minX, bounds.minY, bounds.minZ],
			max: [bounds.maxX, bounds.maxY, bounds.maxZ],
		};
	}
	public getBoxes(): RegionBox[] {
		const flat: number[] = JSON.parse(this.native.boxesJson());
		const boxes: RegionBox[] = [];
		for (let i = 0; i < flat.length; i += 6)
			boxes.push({
				min: [flat[i], flat[i + 1], flat[i + 2]],
				max: [flat[i + 3], flat[i + 4], flat[i + 5]],
			});
		return boxes;
	}
	public positions(): RegionPosition[] {
		const flat: number[] = JSON.parse(this.native.positionsJson());
		const positions: RegionPosition[] = [];
		for (let i = 0; i < flat.length; i += 3) positions.push([flat[i], flat[i + 1], flat[i + 2]]);
		return positions;
	}
	public positionsSorted(): RegionPosition[] {
		// Preserve the old YXZ bit order; the newer positionsSortedJson API sorts YZX.
		return this.positions().sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
	}
	public dimensions(): RegionPosition {
		const d = this.native.dimensions();
		return [d.x, d.y, d.z];
	}
	public center(): RegionPosition | null {
		if (this.isEmpty()) return null;
		const p = this.native.center();
		return [p.x, p.y, p.z];
	}
	public centerF32(): RegionPosition | null {
		return this.isEmpty() ? null : JSON.parse(this.native.centerF32Json());
	}
	public intersectsBounds(
		minX: number,
		minY: number,
		minZ: number,
		maxX: number,
		maxY: number,
		maxZ: number
	): boolean {
		return Boolean(this.native.intersectsBounds(minX, minY, minZ, maxX, maxY, maxZ));
	}
	public copy(): DefinitionRegionWrapper {
		return this.wrap(this.native.copy());
	}
	public clone(): DefinitionRegionWrapper {
		return this.copy();
	}
	public shift(x: number, y: number, z: number): this {
		this.native.shift(x, y, z);
		return this.sync();
	}
	public shifted(x: number, y: number, z: number): DefinitionRegionWrapper {
		return this.wrap(this.native.shifted(x, y, z));
	}
	public expand(x: number, y: number, z: number): this {
		this.native.expand(x, y, z);
		return this.sync();
	}
	public expanded(x: number, y: number, z: number): DefinitionRegionWrapper {
		return this.wrap(this.native.expanded(x, y, z));
	}
	public contract(amount: number): this {
		this.native.contract(amount);
		return this.sync();
	}
	public contracted(amount: number): DefinitionRegionWrapper {
		return this.wrap(this.native.contracted(amount));
	}
	public union(other: DefinitionRegionWrapper): DefinitionRegionWrapper {
		return this.wrap(this.native.unionWith(other.native));
	}
	public unionInto(other: DefinitionRegionWrapper): this {
		this.native.unionInto(other.native);
		return this.sync();
	}
	public merge(other: DefinitionRegionWrapper): this {
		this.native.merge(other.native);
		return this.sync();
	}
	public intersected(other: DefinitionRegionWrapper): DefinitionRegionWrapper {
		return this.wrap(this.native.intersected(other.native));
	}
	public intersect(other: DefinitionRegionWrapper): this {
		this.replaceNative(this.native.intersected(other.native));
		return this.sync();
	}
	public subtracted(other: DefinitionRegionWrapper): DefinitionRegionWrapper {
		return this.wrap(this.native.subtracted(other.native));
	}
	public subtract(other: DefinitionRegionWrapper): this {
		this.replaceNative(this.native.subtracted(other.native));
		return this.sync();
	}
	public simplify(): this {
		this.native.simplify();
		return this.sync();
	}
	public filterByBlock(schematic: SchematicWrapper, blockName: string): DefinitionRegionWrapper {
		return DefinitionRegionWrapper.fromNative(
			this.native.filterByBlock(schematic.native, blockName),
			schematic
		);
	}
	public filterByProperties(
		schematic: SchematicWrapper,
		properties: Record<string, string>
	): DefinitionRegionWrapper {
		return DefinitionRegionWrapper.fromNative(
			this.native.filterByProperties(schematic.native, JSON.stringify(properties)),
			schematic
		);
	}
	public excludeBlock(blockName: string): this {
		if (!this.schematic) throw new Error("Region is not attached to a schematic");
		this.native.excludeBlock(this.schematic.native, blockName);
		return this.sync();
	}
	public getBlocks(): Array<{
		x: number;
		y: number;
		z: number;
		block: string;
	}> {
		if (!this.schematic) throw new Error("Region is not attached to a schematic");
		const blocks: Array<{ x: number; y: number; z: number; name: string }> = JSON.parse(
			this.native.blocksJson(this.schematic.native)
		);
		return blocks.map(({ x, y, z, name }) => ({ x, y, z, block: name }));
	}
	public override free(): void {
		super.free();
		this.schematic = undefined;
		this.regionName = undefined;
	}
}

export class SortStrategyWrapper extends NativeHandle<SortStrategy> {
	private constructor(native: SortStrategy) {
		super(native);
	}
	static yxz(): SortStrategyWrapper {
		return new SortStrategyWrapper(getNucleation().SortStrategy.yxz());
	}
	static xyz(): SortStrategyWrapper {
		return new SortStrategyWrapper(getNucleation().SortStrategy.xyz());
	}
	static zyx(): SortStrategyWrapper {
		return new SortStrategyWrapper(getNucleation().SortStrategy.zyx());
	}
	static yDescXZ(): SortStrategyWrapper {
		return new SortStrategyWrapper(getNucleation().SortStrategy.yDescXz());
	}
	static xDescYZ(): SortStrategyWrapper {
		return new SortStrategyWrapper(getNucleation().SortStrategy.xDescYz());
	}
	static zDescYX(): SortStrategyWrapper {
		return new SortStrategyWrapper(getNucleation().SortStrategy.zDescYx());
	}
	static descending(): SortStrategyWrapper {
		return new SortStrategyWrapper(getNucleation().SortStrategy.descending());
	}
	static distanceFrom(x: number, y: number, z: number): SortStrategyWrapper {
		return new SortStrategyWrapper(getNucleation().SortStrategy.distanceFrom(x, y, z));
	}
	static distanceFromDesc(x: number, y: number, z: number): SortStrategyWrapper {
		return new SortStrategyWrapper(getNucleation().SortStrategy.distanceFromDesc(x, y, z));
	}
	static preserve(): SortStrategyWrapper {
		return new SortStrategyWrapper(getNucleation().SortStrategy.preserve());
	}
	static reverse(): SortStrategyWrapper {
		return new SortStrategyWrapper(getNucleation().SortStrategy.reverse());
	}
	static fromString(value: string): SortStrategyWrapper {
		return new SortStrategyWrapper(getNucleation().SortStrategy.fromString(value));
	}
	get name(): string {
		return this.native.name();
	}
}
