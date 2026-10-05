import { getNucleation } from "./runtime";
import type { MchprsWorld, RedstoneGraph } from "nucleation";
import { SchematicWrapper } from "./SchematicWrapper";

export class SimulationOptionsWrapper {
	public optimize = false;
	public io_only = false;
	public readonly customIoPositions: number[] = [];

	addCustomIo(x: number, y: number, z: number): void {
		this.customIoPositions.push(x, y, z);
	}

	clearCustomIo(): void {
		this.customIoPositions.length = 0;
	}

	free(): void {
		this.clearCustomIo();
	}

	[Symbol.dispose](): void {
		this.free();
	}
}

interface CustomIoChange {
	x: number;
	y: number;
	z: number;
	oldPower: number;
	newPower: number;
}

function parseChanges(json: string): CustomIoChange[] {
	const changes = JSON.parse(json) as Array<{
		x: number;
		y: number;
		z: number;
		old_power: number;
		new_power: number;
	}>;
	return changes.map(({ x, y, z, old_power, new_power }) => ({
		x,
		y,
		z,
		oldPower: old_power,
		newPower: new_power,
	}));
}

/** Compatibility facade for the former wasm-bindgen simulation API. */
export class MchprsWorldWrapper {
	private world: MchprsWorld | null;

	constructor(schematic: SchematicWrapper, options?: SimulationOptionsWrapper) {
		this.world = options
			? getNucleation().MchprsWorld.createWithCustomIo(
					schematic.native,
					options.optimize,
					options.io_only,
					options.customIoPositions
				)
			: getNucleation().MchprsWorld.create(schematic.native);
	}

	get native(): MchprsWorld {
		if (!this.world) throw new Error("Simulation world has been freed");
		return this.world;
	}

	static with_options(
		schematic: SchematicWrapper,
		options: SimulationOptionsWrapper
	): MchprsWorldWrapper {
		return new MchprsWorldWrapper(schematic, options);
	}

	tick(ticks: number): void {
		this.native.tick(ticks);
	}
	flush(): void {
		this.native.flush();
	}
	on_use_block(x: number, y: number, z: number): void {
		this.native.onUseBlock(x, y, z);
	}
	get_lever_power(x: number, y: number, z: number): boolean {
		return Boolean(this.native.getLeverPower(x, y, z));
	}
	get_redstone_power(x: number, y: number, z: number): number {
		return this.native.getRedstonePower(x, y, z);
	}
	is_lit(x: number, y: number, z: number): boolean {
		return Boolean(this.native.isLit(x, y, z));
	}
	getSignalStrength(x: number, y: number, z: number): number {
		return this.native.getSignalStrength(x, y, z);
	}
	setSignalStrength(x: number, y: number, z: number, strength: number): void {
		this.native.setSignalStrength(x, y, z, strength);
	}
	sync_to_schematic(): void {
		this.native.syncToSchematic();
	}
	get_schematic(): SchematicWrapper {
		return SchematicWrapper.fromNative(this.native.getSchematic(), "owned");
	}
	into_schematic(): SchematicWrapper {
		this.sync_to_schematic();
		const schematic = this.get_schematic();
		this.free();
		return schematic;
	}
	checkCustomIoChanges(): void {
		this.native.checkCustomIoChanges();
	}
	pollCustomIoChanges(): CustomIoChange[] {
		return parseChanges(this.native.pollCustomIoChangesJson());
	}
	peekCustomIoChanges(): CustomIoChange[] {
		return parseChanges(this.native.peekCustomIoChangesJson());
	}
	clearCustomIoChanges(): void {
		this.native.clearCustomIoChanges();
	}
	exportGraph(): RedstoneGraph {
		return this.native.exportGraph();
	}
	exportGraphStructural(): RedstoneGraph {
		return this.native.exportGraphStructural();
	}

	/** Native Diplomat bindings release their WASM allocation through finalization. */
	free(): void {
		this.world = null;
	}
	[Symbol.dispose](): void {
		this.free();
	}
}
