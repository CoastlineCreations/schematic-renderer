import { getNucleation } from "./runtime";
import { diffRegions } from "./diffRegions";
import type { BlockState, Diff, Schematic, SchematicBuilder } from "nucleation";
import type { MeshBlockEntity } from "../workers/types";
import type { DslMap } from "../types/insign";
import {
	allBlockIndices,
	chunkBlockIndices,
	createChunkIterator,
	getRenderPalette,
	getRenderBounds,
	invalidateRenderSnapshot,
} from "./chunks";
import { BlockPosition, DefinitionRegionWrapper } from "./regions";
import { CircuitBuilderWrapper } from "./circuits";
import { MchprsWorldWrapper, SimulationOptionsWrapper } from "./simulation";

const coordinates = ({ x, y, z }: { x: number; y: number; z: number }) => new Int32Array([x, y, z]);
const json = <T>(value: string): T => JSON.parse(value) as T;
const decode = (value: string): Uint8Array =>
	Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
function optional<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch (error) {
		if (error instanceof Error && error.message === "NucleationError.NotFound") return undefined;
		throw error;
	}
}

export class BlockStateWrapper {
	private state: BlockState | null;
	constructor(name: string) {
		this.state = getNucleation().BlockState.create(name);
	}
	static fromNative(state: BlockState): BlockStateWrapper {
		const wrapper = Object.create(BlockStateWrapper.prototype) as BlockStateWrapper;
		wrapper.state = state;
		return wrapper;
	}
	get native(): BlockState {
		if (!this.state) throw new Error("Block state has been freed");
		return this.state;
	}
	name(): string {
		return this.native.name();
	}
	properties(): Record<string, string> {
		return json(this.native.propertiesJson());
	}
	with_property(key: string, value: string): void {
		this.state = this.native.withProperty(key, value);
	}
	free(): void {
		this.state = null;
	}
	[Symbol.dispose](): void {
		this.free();
	}
}

/** Compatibility facade. Mutations invalidate the bounded render snapshot. */
export class SchematicWrapper {
	private schematic: Schematic | null;
	private ownsNative = true;
	constructor() {
		this.schematic = getNucleation().Schematic.create("");
	}
	/**
	 * Wrap an existing native handle without taking its ownership by default.
	 * Freeing a borrowed wrapper never clears the caller's schematic. Pass "owned"
	 * only to transfer a newly allocated handle: free() may then clear its contents.
	 * Native aliases remain valid empty handles after owned cleanup; Diplomat alone
	 * destroys the opaque allocation through its finalizer.
	 */
	static fromNative(
		schematic: Schematic,
		ownership: "borrowed" | "owned" = "borrowed"
	): SchematicWrapper {
		const wrapper = Object.create(SchematicWrapper.prototype) as SchematicWrapper;
		wrapper.schematic = schematic;
		wrapper.ownsNative = ownership === "owned";
		return wrapper;
	}
	get native(): Schematic {
		if (!this.schematic) throw new Error("Schematic has been freed");
		return this.schematic;
	}
	/** Call after mutating the exposed native handle directly. */
	invalidateCaches(): void {
		invalidateRenderSnapshot(this.native);
	}
	private mutate<T>(change: (schematic: Schematic) => T): T {
		this.invalidateCaches();
		return change(this.native);
	}
	private replace(schematic: Schematic): void {
		if (this.schematic === schematic) return;
		this.free();
		this.schematic = schematic;
		this.ownsNative = true;
	}
	/** Release owned block storage immediately when supported, without bypassing native finalizers. */
	free(): void {
		const schematic = this.schematic;
		const owned = this.ownsNative;
		this.schematic = null;
		this.ownsNative = false;
		if (!schematic || !owned) return;
		invalidateRenderSnapshot(schematic);
		if ("clearContents" in schematic && typeof schematic.clearContents === "function") {
			schematic.clearContents();
		}
	}
	[Symbol.dispose](): void {
		this.free();
	}
	from_data(data: Uint8Array): void {
		this.replace(getNucleation().Schematic.fromData(Array.from(data)));
	}
	from_litematic(data: Uint8Array): void {
		this.replace(getNucleation().Schematic.fromLitematic(Array.from(data)));
	}
	from_schematic(data: Uint8Array): void {
		this.replace(getNucleation().Schematic.fromSchematic(Array.from(data)));
	}
	from_mcstructure(data: Uint8Array): void {
		this.replace(getNucleation().Schematic.fromMcstructure(Array.from(data)));
	}
	from_world_zip(data: Uint8Array): void {
		this.replace(getNucleation().Schematic.fromWorldZip(Array.from(data)));
	}
	from_mca(data: Uint8Array): void {
		this.replace(getNucleation().Schematic.fromMca(Array.from(data)));
	}
	fromSnapshot(data: Uint8Array): void {
		this.replace(getNucleation().Schematic.fromSnapshot(Array.from(data)));
	}
	to_litematic(): Uint8Array {
		return decode(this.native.toLitematicB64());
	}
	to_schematic(): Uint8Array {
		return decode(this.native.toSchematicB64());
	}
	to_mcstructure(): Uint8Array {
		return decode(this.native.toMcstructureB64());
	}
	toSnapshot(): Uint8Array {
		return decode(this.native.toSnapshotB64());
	}
	get_dimensions(): Int32Array {
		return coordinates(this.native.dimensions());
	}
	get_tight_dimensions(): Int32Array {
		const bounds = getRenderBounds(this.native);
		return new Int32Array(
			bounds ? bounds.max.map((value, axis) => value - bounds.min[axis] + 1) : [0, 0, 0]
		);
	}
	get_allocated_dimensions(): Int32Array {
		return coordinates(this.native.allocatedDimensions());
	}
	get_tight_bounds_min(): Int32Array | undefined {
		const bounds = getRenderBounds(this.native);
		return bounds ? new Int32Array(bounds.min) : undefined;
	}
	get_tight_bounds_max(): Int32Array | undefined {
		const bounds = getRenderBounds(this.native);
		return bounds ? new Int32Array(bounds.max) : undefined;
	}
	flip_x(): void {
		this.mutate((s) => s.flipX());
	}
	flip_y(): void {
		this.mutate((s) => s.flipY());
	}
	flip_z(): void {
		this.mutate((s) => s.flipZ());
	}
	rotate_x(degrees: number): void {
		this.mutate((s) => s.rotateX(degrees));
	}
	rotate_y(degrees: number): void {
		this.mutate((s) => s.rotateY(degrees));
	}
	rotate_z(degrees: number): void {
		this.mutate((s) => s.rotateZ(degrees));
	}
	getName(): string {
		return this.native.name();
	}
	setName(value: string): void {
		this.native.setName(value);
	}
	getAuthor(): string {
		return this.native.author();
	}
	setAuthor(value: string): void {
		this.native.setAuthor(value);
	}
	getDescription(): string {
		return this.native.description();
	}
	setDescription(value: string): void {
		this.native.setDescription(value);
	}
	getCreated(): number {
		return Number(this.native.created());
	}
	setCreated(value: number): void {
		this.native.setCreated(BigInt(value));
	}
	getModified(): number {
		return Number(this.native.modified());
	}
	setModified(value: number): void {
		this.native.setModified(BigInt(value));
	}
	getMcVersion(): number {
		return Number(this.native.mcVersion());
	}
	setMcVersion(value: number): void {
		this.native.setMcVersion(value);
	}
	getLmVersion(): number {
		return Number(this.native.lmVersion());
	}
	setLmVersion(value: number): void {
		this.native.setLmVersion(value);
	}
	getWeVersion(): number {
		return Number(this.native.weVersion());
	}
	setWeVersion(value: number): void {
		this.native.setWeVersion(value);
	}

	to_world_zip(options?: string | null): Uint8Array {
		return decode(this.native.toWorldZipB64(options ?? ""));
	}
	to_schematic_version(version: string): Uint8Array {
		return decode(this.native.toSchematicVersionB64(version));
	}
	save_as(format: string, version?: string | null, settings?: string | null): Uint8Array {
		return decode(this.native.saveAsB64(format, version ?? "", settings ?? ""));
	}
	get_bounding_box(): { min: number[]; max: number[] } {
		const bounds = json<number[]>(this.native.boundingBoxJson());
		return { min: bounds.slice(0, 3), max: bounds.slice(3) };
	}
	get_region_bounding_box(name: string): { min: number[]; max: number[] } {
		const bounds = json<number[]>(this.native.regionBoundingBoxJson(name));
		return { min: bounds.slice(0, 3), max: bounds.slice(3) };
	}
	get_region_names(): string[] {
		return json(this.native.regionNamesJson());
	}
	get_block_count(): number {
		return this.native.blockCount();
	}
	get_volume(): number {
		return this.native.volume();
	}
	get_block(x: number, y: number, z: number): string | undefined {
		return optional(() => this.native.getBlockName(x, y, z));
	}
	get_block_string(x: number, y: number, z: number): string | undefined {
		return optional(() => this.native.getBlockString(x, y, z));
	}
	get_block_with_properties(x: number, y: number, z: number): BlockStateWrapper | undefined {
		return optional(() =>
			BlockStateWrapper.fromNative(this.native.getBlockWithProperties(x, y, z))
		);
	}
	get_blocks(positions: Int32Array): Array<string | null> {
		return json(this.native.getBlocksJson(Array.from(positions)));
	}
	set_block(x: number, y: number, z: number, block: string): boolean {
		return Boolean(this.mutate((s) => s.setBlock(x, y, z, block)));
	}
	set_blocks(positions: Int32Array, block: string): number {
		return this.mutate((s) => s.setBlocks(Array.from(positions), block));
	}
	set_block_from_string(x: number, y: number, z: number, block: string): void {
		this.mutate((s) => s.setBlockFromString(x, y, z, block));
	}
	set_block_with_properties(
		x: number,
		y: number,
		z: number,
		block: string,
		properties: Record<string, string>
	): void {
		this.mutate((s) => s.setBlockWithProperties(x, y, z, block, JSON.stringify(properties)));
	}
	setBlockWithNbt(
		x: number,
		y: number,
		z: number,
		block: string,
		nbt: Record<string, unknown>
	): void {
		if (Object.values(nbt).some((value) => typeof value !== "string")) {
			throw new Error("NBT values should be strings");
		}
		this.mutate((s) => s.setBlockWithNbt(x, y, z, block, JSON.stringify(nbt)));
	}
	set_block_in_region(region: string, x: number, y: number, z: number, block: string): boolean {
		this.mutate((s) => s.setBlockInRegion(region, x, y, z, block));
		return true;
	}
	prepareBlock(name: string): number {
		return this.mutate((s) => s.prepareBlock(name));
	}
	place(x: number, y: number, z: number, index: number): void {
		this.mutate((s) => s.place(x, y, z, index));
	}
	get_palette() {
		return getRenderPalette(this.native);
	}
	get_all_palettes() {
		return { default: this.get_palette() };
	}
	get_default_region_palette() {
		return this.get_palette();
	}
	blocks_indices() {
		return allBlockIndices(this.native);
	}
	get_chunk_blocks_indices(
		x: number,
		y: number,
		z: number,
		width: number,
		height: number,
		length: number
	) {
		return chunkBlockIndices(this.native, x, y, z, width, height, length);
	}
	create_lazy_chunk_iterator(
		width: number,
		height: number,
		length: number,
		strategy: string,
		x: number,
		y: number,
		z: number
	) {
		return createChunkIterator(this.native, width, height, length, strategy, x, y, z);
	}
	getChunkData(x: number, y: number, z: number, width: number, height: number, length: number) {
		const min = [x * width, y * height, z * length];
		return {
			blocks: this.get_chunk_blocks_indices(min[0], min[1], min[2], width, height, length),
			entities: this.get_all_block_entities().filter(
				({ position: p }) =>
					p[0] >= min[0] &&
					p[0] < min[0] + width &&
					p[1] >= min[1] &&
					p[1] < min[1] + height &&
					p[2] >= min[2] &&
					p[2] < min[2] + length
			),
		};
	}
	get_all_block_entities(): MeshBlockEntity[] {
		return json(this.native.getAllBlockEntitiesJson());
	}
	get_block_entity(x: number, y: number, z: number): MeshBlockEntity | undefined {
		return optional(() => json<MeshBlockEntity>(this.native.getBlockEntityJson(x, y, z)));
	}
	getBlockEntitySnbt(x: number, y: number, z: number): string | undefined {
		return optional(() => this.native.getBlockEntitySnbt(x, y, z));
	}
	setBlockEntity(x: number, y: number, z: number, id: string, snbt: string): void {
		this.mutate((s) => s.setBlockEntity(x, y, z, id, snbt));
	}
	removeBlockEntity(x: number, y: number, z: number): boolean {
		return (
			optional(() => {
				this.mutate((s) => s.removeBlockEntity(x, y, z));
				return true;
			}) ?? false
		);
	}
	get_entities(): MeshBlockEntity[] {
		return json(this.native.getEntitiesJson());
	}
	entity_count(): number {
		return this.native.entityCount();
	}
	add_entity(id: string, x: number, y: number, z: number, nbt?: string | null): void {
		this.mutate((s) => s.addEntity(id, x, y, z, nbt ?? "{}"));
	}
	remove_entity(index: number): boolean {
		return (
			optional(() => {
				this.mutate((s) => s.removeEntity(index));
				return true;
			}) ?? false
		);
	}
	getEntitiesSnbt(): string[] {
		return json(this.native.getEntitiesSnbtJson());
	}
	getAllBlockEntitiesSnbt(): Array<{ id: string; position: number[]; snbt: string }> {
		return json(this.native.getAllBlockEntitiesSnbtJson());
	}
	addEntityFromSnbt(snbt: string): void {
		this.mutate((s) => s.addEntityFromSnbt(snbt));
	}
	compileInsign(): DslMap {
		return json(this.native.compileInsignJson());
	}
	getDefinitionRegionNames(): string[] {
		return json(getNucleation().SchematicRegions.namesJson(this.native));
	}
	getDefinitionRegion(name: string): DefinitionRegionWrapper {
		return DefinitionRegionWrapper.fromNative(
			getNucleation().SchematicRegions.get(this.native, name),
			this,
			name
		);
	}
	addDefinitionRegion(name: string, region: DefinitionRegionWrapper): void {
		getNucleation().SchematicRegions.add(this.native, name, region.native);
	}
	updateRegion(name: string, region: DefinitionRegionWrapper): void {
		getNucleation().SchematicRegions.update(this.native, name, region.native);
	}
	removeDefinitionRegion(name: string): boolean {
		return (
			optional(() => {
				getNucleation().SchematicRegions.remove(this.native, name);
				return true;
			}) ?? false
		);
	}
	createDefinitionRegion(name: string): void {
		getNucleation().SchematicRegions.create(this.native, name);
	}
	createDefinitionRegionFromPoint(name: string, x: number, y: number, z: number): void {
		getNucleation().SchematicRegions.createFromPoint(this.native, name, x, y, z);
	}
	createDefinitionRegionFromBounds(name: string, min: BlockPosition, max: BlockPosition): void {
		getNucleation().SchematicRegions.createFromBounds(
			this.native,
			name,
			min.x,
			min.y,
			min.z,
			max.x,
			max.y,
			max.z
		);
	}
	createRegion(name: string, min: number[], max: number[]): DefinitionRegionWrapper {
		return DefinitionRegionWrapper.fromNative(
			getNucleation().SchematicRegions.createRegion(
				this.native,
				name,
				min[0],
				min[1],
				min[2],
				max[0],
				max[1],
				max[2]
			),
			this,
			name
		);
	}
	definitionRegionAddPoint(name: string, x: number, y: number, z: number): void {
		getNucleation().SchematicRegions.addPointTo(this.native, name, x, y, z);
	}
	definitionRegionAddBounds(name: string, min: BlockPosition, max: BlockPosition): void {
		getNucleation().SchematicRegions.addBoundsTo(
			this.native,
			name,
			min.x,
			min.y,
			min.z,
			max.x,
			max.y,
			max.z
		);
	}
	definitionRegionSetMetadata(name: string, key: string, value: string): void {
		getNucleation().SchematicRegions.setMetadataOn(this.native, name, key, value);
	}
	definitionRegionShift(name: string, x: number, y: number, z: number): void {
		getNucleation().SchematicRegions.shiftRegion(this.native, name, x, y, z);
	}
	create_simulation_world(): MchprsWorldWrapper {
		return new MchprsWorldWrapper(this);
	}
	create_simulation_world_with_options(options: SimulationOptionsWrapper): MchprsWorldWrapper {
		return new MchprsWorldWrapper(this, options);
	}
	createCircuitBuilder(): CircuitBuilderWrapper {
		return new CircuitBuilderWrapper(this);
	}
	copy_region(
		source: SchematicWrapper,
		minX: number,
		minY: number,
		minZ: number,
		maxX: number,
		maxY: number,
		maxZ: number,
		x: number,
		y: number,
		z: number,
		excluded: string[]
	): void {
		this.mutate((s) =>
			s.copyRegion(
				source.native,
				minX,
				minY,
				minZ,
				maxX,
				maxY,
				maxZ,
				x,
				y,
				z,
				JSON.stringify(excluded)
			)
		);
	}
	fillCuboid(
		minX: number,
		minY: number,
		minZ: number,
		maxX: number,
		maxY: number,
		maxZ: number,
		block: string
	): void {
		this.mutate((s) => s.fillCuboid(minX, minY, minZ, maxX, maxY, maxZ, block));
	}
	fillSphere(x: number, y: number, z: number, radius: number, block: string): void {
		this.mutate((s) => s.fillSphere(x, y, z, radius, block));
	}
	getSourceDataVersion(): number | undefined {
		const value = this.native.sourceDataVersion();
		return value < 0 ? undefined : value;
	}
	setSourceDataVersion(value: number): void {
		this.native.setSourceDataVersion(value);
	}
	static canonicalDataVersion(): number {
		return getNucleation().Schematic.canonicalDataVersion();
	}
	convertToVersion(version: number): string {
		return this.mutate((s) => s.convertToVersion(version));
	}
	convertToDataVersion(target: number, source: number): string {
		return this.mutate((s) => s.convertToDataVersion(target, source));
	}
	debug_info(): string {
		return this.native.debugInfo();
	}
	print_schematic(): string {
		return this.native.printSchematicString();
	}
	fingerprint(preset = "exact"): string {
		return getNucleation().Fingerprint.compute(this.native, preset);
	}
	isDuplicateOf(other: SchematicWrapper, preset = "exact"): boolean {
		return Boolean(getNucleation().Fingerprint.isDuplicate(this.native, other.native, preset));
	}
	footprintDistance(other: SchematicWrapper, preset = "exact"): number {
		return getNucleation().Fingerprint.footprintDistance(this.native, other.native, preset);
	}
	footprint(preset = "exact"): Float32Array {
		return new Float32Array(
			json<number[]>(getNucleation().Fingerprint.footprintJson(this.native, preset))
		);
	}
	signature(preset = "exact"): string {
		return getNucleation().Fingerprint.signatureJson(this.native, preset);
	}
	diff(
		other: SchematicWrapper,
		preset?: string | null,
		options: {
			cost_add?: number;
			cost_delete?: number;
			cost_change?: number;
			cost_swap?: number;
			symmetry?: string;
		} = {}
	): DiffWrapper {
		return new DiffWrapper(
			getNucleation().Diff.computeWithOpts(
				this.native,
				other.native,
				preset ?? "exact",
				options.cost_add ?? -1,
				options.cost_delete ?? -1,
				options.cost_change ?? -1,
				options.cost_swap ?? -1,
				options.symmetry ?? ""
			)
		);
	}
}

export class DiffWrapper {
	private diff: Diff | null;
	constructor(diff: Diff) {
		this.diff = diff;
	}
	get native(): Diff {
		if (!this.diff) throw new Error("Diff has been freed");
		return this.diff;
	}
	get distance(): number {
		return Number(this.native.distance());
	}
	get support(): number {
		return this.native.support();
	}
	added(): SchematicWrapper {
		return SchematicWrapper.fromNative(this.native.added(), "owned");
	}
	removed(): SchematicWrapper {
		return SchematicWrapper.fromNative(this.native.removed(), "owned");
	}
	changed(): SchematicWrapper {
		return SchematicWrapper.fromNative(this.native.changed(), "owned");
	}
	swapped(): SchematicWrapper {
		return SchematicWrapper.fromNative(this.native.swapped(), "owned");
	}
	markers(): SchematicWrapper {
		return SchematicWrapper.fromNative(this.native.markers(), "owned");
	}
	toJson(): string {
		return this.native.toJson();
	}
	static fromJson(value: string): DiffWrapper {
		return new DiffWrapper(getNucleation().Diff.fromJson(value));
	}
	summaryJson(): string {
		return this.native.summaryJson();
	}
	regionsJson(): string {
		return JSON.stringify(diffRegions(this.native.toJson()));
	}
	toOverlayGlb(afterGlb: Uint8Array): Uint8Array {
		return decode(this.native.toOverlayGlbB64(Array.from(afterGlb)));
	}
	summary(): string {
		return this.summaryJson();
	}
	free(): void {
		this.diff = null;
	}
	[Symbol.dispose](): void {
		this.free();
	}
}

export class SchematicBuilderWrapper {
	private builder: SchematicBuilder | null;
	constructor() {
		this.builder = getNucleation().SchematicBuilder.create();
	}
	get native(): SchematicBuilder {
		if (!this.builder) throw new Error("Schematic builder has been freed");
		return this.builder;
	}
	static fromTemplate(template: string): SchematicBuilderWrapper {
		const result = Object.create(SchematicBuilderWrapper.prototype) as SchematicBuilderWrapper;
		result.builder = getNucleation().SchematicBuilder.fromTemplate(template);
		return result;
	}
	name(value: string): this {
		this.native.name(value);
		return this;
	}
	map(ch: string, block: string): this {
		this.native.map(ch, block);
		return this;
	}
	layer(rows: string[]): this {
		this.native.layer(JSON.stringify(rows));
		return this;
	}
	layers(layers: string[][]): this {
		this.native.layers(JSON.stringify(layers));
		return this;
	}
	palette(mappings: Record<string, string> | Array<[string, string]>): this {
		this.native.palette(
			JSON.stringify(Array.isArray(mappings) ? mappings : Object.entries(mappings))
		);
		return this;
	}
	offset(x: number, y: number, z: number): this {
		this.native.offset(x, y, z);
		return this;
	}
	useStandardPalette(): this {
		this.native.useStandardPalette();
		return this;
	}
	useMinimalPalette(): this {
		this.native.useMinimalPalette();
		return this;
	}
	useCompactPalette(): this {
		this.native.useCompactPalette();
		return this;
	}
	validate(): void {
		this.native.validate();
	}
	toTemplate(): string {
		return this.native.toTemplate();
	}
	build(): SchematicWrapper {
		return SchematicWrapper.fromNative(this.native.build(), "owned");
	}
	free(): void {
		this.builder = null;
	}
	[Symbol.dispose](): void {
		this.free();
	}
}
