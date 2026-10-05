import { getNucleation } from "./runtime";
import type {
	CircuitBuilder,
	ExecutionMode,
	IoLayout,
	IoLayoutBuilder,
	IoType,
	LayoutFunction,
	OutputCondition,
	TypedCircuitExecutor,
	Value,
} from "nucleation";
import { NativeHandle } from "./NativeHandle";
import {
	BlockPosition,
	DefinitionRegionWrapper,
	SortStrategyWrapper,
	type RegionPosition,
} from "./regions";
import { SchematicWrapper } from "./SchematicWrapper";
import type { MchprsWorldWrapper, SimulationOptionsWrapper } from "./simulation";

export type CircuitScalar = number | boolean | string;
export interface CircuitValue {
	type: string;
	value: CircuitScalar;
}
export interface CircuitExecutionResult {
	outputs: Record<string, CircuitScalar>;
	ticksElapsed: number;
	conditionMet: boolean;
}
export interface CircuitLayoutEntry {
	ioType: string;
	bitCount: number;
	positions: RegionPosition[];
}
export interface CircuitLayoutInfo {
	inputs: Record<string, CircuitLayoutEntry>;
	outputs: Record<string, CircuitLayoutEntry>;
}

type CircuitInputs = Record<string, CircuitScalar | ValueWrapper | CircuitValue>;

export class StateModeConstants {
	static readonly MANUAL = "manual";
	static readonly STATEFUL = "stateful";
	static readonly STATELESS = "stateless";
}

export class IoTypeWrapper extends NativeHandle<IoType> {
	private constructor(native: IoType) {
		super(native);
	}
	static signedInt(bits: number): IoTypeWrapper {
		return new IoTypeWrapper(getNucleation().IoType.signedInt(bits));
	}
	static unsignedInt(bits: number): IoTypeWrapper {
		return new IoTypeWrapper(getNucleation().IoType.unsignedInt(bits));
	}
	static ascii(chars: number): IoTypeWrapper {
		return new IoTypeWrapper(getNucleation().IoType.ascii(chars));
	}
	static boolean(): IoTypeWrapper {
		return new IoTypeWrapper(getNucleation().IoType.boolean());
	}
	static float32(): IoTypeWrapper {
		return new IoTypeWrapper(getNucleation().IoType.float32());
	}
}

export class LayoutFunctionWrapper extends NativeHandle<LayoutFunction> {
	private constructor(native: LayoutFunction) {
		super(native);
	}
	static oneToOne(): LayoutFunctionWrapper {
		return new LayoutFunctionWrapper(getNucleation().LayoutFunction.oneToOne());
	}
	static packed4(): LayoutFunctionWrapper {
		return new LayoutFunctionWrapper(getNucleation().LayoutFunction.packed4());
	}
	static custom(mapping: Uint32Array | number[]): LayoutFunctionWrapper {
		return new LayoutFunctionWrapper(getNucleation().LayoutFunction.custom(Array.from(mapping)));
	}
	static columnMajor(rows: number, cols: number, bitsPerElement: number): LayoutFunctionWrapper {
		return new LayoutFunctionWrapper(
			getNucleation().LayoutFunction.columnMajor(rows, cols, bitsPerElement)
		);
	}
	static rowMajor(rows: number, cols: number, bitsPerElement: number): LayoutFunctionWrapper {
		return new LayoutFunctionWrapper(
			getNucleation().LayoutFunction.rowMajor(rows, cols, bitsPerElement)
		);
	}
	static scanline(width: number, height: number, bitsPerPixel: number): LayoutFunctionWrapper {
		return new LayoutFunctionWrapper(
			getNucleation().LayoutFunction.scanline(width, height, bitsPerPixel)
		);
	}
}

export class ValueWrapper extends NativeHandle<Value> {
	private constructor(native: Value) {
		super(native);
	}
	static fromNative(native: Value): ValueWrapper {
		return new ValueWrapper(native);
	}
	static fromU32(value: number): ValueWrapper {
		return new ValueWrapper(getNucleation().Value.fromU32(value));
	}
	static fromI32(value: number): ValueWrapper {
		return new ValueWrapper(getNucleation().Value.fromI32(value));
	}
	static fromF32(value: number): ValueWrapper {
		return new ValueWrapper(getNucleation().Value.fromF32(value));
	}
	static fromBool(value: boolean): ValueWrapper {
		return new ValueWrapper(getNucleation().Value.fromBool(value));
	}
	static fromString(value: string): ValueWrapper {
		return new ValueWrapper(getNucleation().Value.fromString(value));
	}
	public typeName(): string {
		return this.native.typeName();
	}
	public toJs(): CircuitScalar {
		switch (this.typeName()) {
			case "u32":
				return this.native.asU32();
			case "i32":
				return this.native.asI32();
			case "f32":
				return this.native.asF32();
			case "bool":
				return this.native.asBool();
			case "string":
				return this.native.asString();
			default:
				throw new Error(`Unsupported circuit value type: ${this.typeName()}`);
		}
	}
}

export class OutputConditionWrapper extends NativeHandle<OutputCondition> {
	private constructor(native: OutputCondition) {
		super(native);
	}
	static equals(value: ValueWrapper): OutputConditionWrapper {
		return new OutputConditionWrapper(getNucleation().OutputCondition.equals(value.native));
	}
	static notEquals(value: ValueWrapper): OutputConditionWrapper {
		return new OutputConditionWrapper(getNucleation().OutputCondition.notEquals(value.native));
	}
	static greaterThan(value: ValueWrapper): OutputConditionWrapper {
		return new OutputConditionWrapper(getNucleation().OutputCondition.greaterThan(value.native));
	}
	static lessThan(value: ValueWrapper): OutputConditionWrapper {
		return new OutputConditionWrapper(getNucleation().OutputCondition.lessThan(value.native));
	}
	static bitwiseAnd(mask: number): OutputConditionWrapper {
		return new OutputConditionWrapper(getNucleation().OutputCondition.bitwiseAnd(mask));
	}
}

export class ExecutionModeWrapper extends NativeHandle<ExecutionMode> {
	private constructor(native: ExecutionMode) {
		super(native);
	}
	static fixedTicks(ticks: number): ExecutionModeWrapper {
		return new ExecutionModeWrapper(getNucleation().ExecutionMode.fixedTicks(ticks));
	}
	static untilChange(maxTicks: number, checkInterval: number): ExecutionModeWrapper {
		return new ExecutionModeWrapper(
			getNucleation().ExecutionMode.untilChange(maxTicks, checkInterval)
		);
	}
	static untilStable(stableTicks: number, maxTicks: number): ExecutionModeWrapper {
		return new ExecutionModeWrapper(
			getNucleation().ExecutionMode.untilStable(stableTicks, maxTicks)
		);
	}
	static untilCondition(
		outputName: string,
		condition: OutputConditionWrapper,
		maxTicks: number,
		checkInterval: number
	): ExecutionModeWrapper {
		return new ExecutionModeWrapper(
			getNucleation().ExecutionMode.untilCondition(
				outputName,
				condition.native,
				maxTicks,
				checkInterval
			)
		);
	}
}

export class IoLayoutWrapper extends NativeHandle<IoLayout> {
	constructor(native: IoLayout) {
		super(native);
	}
	public inputNames(): string[] {
		return JSON.parse(this.native.inputNamesJson());
	}
	public outputNames(): string[] {
		return JSON.parse(this.native.outputNamesJson());
	}
}

function flatPositions(positions: Array<BlockPosition | RegionPosition>): number[] {
	return positions.flatMap((position) =>
		Array.isArray(position) ? position : [position.x, position.y, position.z]
	);
}

export class IoLayoutBuilderWrapper extends NativeHandle<IoLayoutBuilder> {
	constructor() {
		super(getNucleation().IoLayoutBuilder.create());
	}
	public addInput(
		name: string,
		type: IoTypeWrapper,
		layout: LayoutFunctionWrapper,
		positions: Array<BlockPosition | RegionPosition>
	): this {
		this.native.addInput(name, type.native, layout.native, flatPositions(positions));
		return this;
	}
	public addOutput(
		name: string,
		type: IoTypeWrapper,
		layout: LayoutFunctionWrapper,
		positions: Array<BlockPosition | RegionPosition>
	): this {
		this.native.addOutput(name, type.native, layout.native, flatPositions(positions));
		return this;
	}
	public addInputAuto(
		name: string,
		type: IoTypeWrapper,
		positions: Array<BlockPosition | RegionPosition>
	): this {
		this.native.addInputAuto(name, type.native, flatPositions(positions));
		return this;
	}
	public addOutputAuto(
		name: string,
		type: IoTypeWrapper,
		positions: Array<BlockPosition | RegionPosition>
	): this {
		this.native.addOutputAuto(name, type.native, flatPositions(positions));
		return this;
	}
	public addInputFromRegion(
		name: string,
		type: IoTypeWrapper,
		layout: LayoutFunctionWrapper,
		region: DefinitionRegionWrapper
	): this {
		this.native.addInputFromRegion(name, type.native, layout.native, region.positions().flat());
		return this;
	}
	public addOutputFromRegion(
		name: string,
		type: IoTypeWrapper,
		layout: LayoutFunctionWrapper,
		region: DefinitionRegionWrapper
	): this {
		this.native.addOutputFromRegion(name, type.native, layout.native, region.positions().flat());
		return this;
	}
	public addInputFromRegionAuto(
		name: string,
		type: IoTypeWrapper,
		region: DefinitionRegionWrapper
	): this {
		this.native.addInputFromRegionAuto(name, type.native, region.positions().flat());
		return this;
	}
	public addOutputFromRegionAuto(
		name: string,
		type: IoTypeWrapper,
		region: DefinitionRegionWrapper
	): this {
		this.native.addOutputFromRegionAuto(name, type.native, region.positions().flat());
		return this;
	}
	public addInputRegion(
		name: string,
		type: IoTypeWrapper,
		layout: LayoutFunctionWrapper,
		min: BlockPosition,
		max: BlockPosition
	): this {
		const region = DefinitionRegionWrapper.fromBounds(min, max);
		try {
			return this.addInputFromRegion(name, type, layout, region);
		} finally {
			region.free();
		}
	}
	public addOutputRegion(
		name: string,
		type: IoTypeWrapper,
		layout: LayoutFunctionWrapper,
		min: BlockPosition,
		max: BlockPosition
	): this {
		const region = DefinitionRegionWrapper.fromBounds(min, max);
		try {
			return this.addOutputFromRegion(name, type, layout, region);
		} finally {
			region.free();
		}
	}
	public addInputRegionAuto(
		name: string,
		type: IoTypeWrapper,
		min: BlockPosition,
		max: BlockPosition
	): this {
		const region = DefinitionRegionWrapper.fromBounds(min, max);
		try {
			return this.addInputFromRegionAuto(name, type, region);
		} finally {
			region.free();
		}
	}
	public addOutputRegionAuto(
		name: string,
		type: IoTypeWrapper,
		min: BlockPosition,
		max: BlockPosition
	): this {
		const region = DefinitionRegionWrapper.fromBounds(min, max);
		try {
			return this.addOutputFromRegionAuto(name, type, region);
		} finally {
			region.free();
		}
	}
	public build(): IoLayoutWrapper {
		const layout = new IoLayoutWrapper(this.native.build());
		this.free();
		return layout;
	}
}

export class CircuitBuilderWrapper extends NativeHandle<CircuitBuilder> {
	constructor(
		schematic: SchematicWrapper,
		native = getNucleation().CircuitBuilder.create(schematic.native)
	) {
		super(native);
	}
	static fromInsign(schematic: SchematicWrapper): CircuitBuilderWrapper {
		return new CircuitBuilderWrapper(
			schematic,
			getNucleation().CircuitBuilder.fromInsign(schematic.native)
		);
	}
	public withInput(
		name: string,
		type: IoTypeWrapper,
		layout: LayoutFunctionWrapper,
		region: DefinitionRegionWrapper
	): this {
		this.native.withInput(name, type.native, layout.native, region.positions().flat());
		return this;
	}
	public withOutput(
		name: string,
		type: IoTypeWrapper,
		layout: LayoutFunctionWrapper,
		region: DefinitionRegionWrapper
	): this {
		this.native.withOutput(name, type.native, layout.native, region.positions().flat());
		return this;
	}
	public withInputAuto(name: string, type: IoTypeWrapper, region: DefinitionRegionWrapper): this {
		this.native.withInputAuto(name, type.native, region.positions().flat());
		return this;
	}
	public withOutputAuto(name: string, type: IoTypeWrapper, region: DefinitionRegionWrapper): this {
		this.native.withOutputAuto(name, type.native, region.positions().flat());
		return this;
	}
	public withInputSorted(
		name: string,
		type: IoTypeWrapper,
		layout: LayoutFunctionWrapper,
		region: DefinitionRegionWrapper,
		sort: SortStrategyWrapper
	): this {
		this.native.withInputSorted(
			name,
			type.native,
			layout.native,
			region.positions().flat(),
			sort.native
		);
		return this;
	}
	public withOutputSorted(
		name: string,
		type: IoTypeWrapper,
		layout: LayoutFunctionWrapper,
		region: DefinitionRegionWrapper,
		sort: SortStrategyWrapper
	): this {
		this.native.withOutputSorted(
			name,
			type.native,
			layout.native,
			region.positions().flat(),
			sort.native
		);
		return this;
	}
	public withInputAutoSorted(
		name: string,
		type: IoTypeWrapper,
		region: DefinitionRegionWrapper,
		sort: SortStrategyWrapper
	): this {
		this.native.withInputAutoSorted(name, type.native, region.positions().flat(), sort.native);
		return this;
	}
	public withOutputAutoSorted(
		name: string,
		type: IoTypeWrapper,
		region: DefinitionRegionWrapper,
		sort: SortStrategyWrapper
	): this {
		this.native.withOutputAutoSorted(name, type.native, region.positions().flat(), sort.native);
		return this;
	}
	public withOptions(options: SimulationOptionsWrapper): this {
		this.native.withOptions(options.optimize, options.io_only);
		return this;
	}
	public withStateMode(mode: string): this {
		this.native.withStateMode(mode);
		return this;
	}
	public validate(): void {
		this.native.validate();
	}
	public inputCount(): number {
		return this.native.inputCount();
	}
	public outputCount(): number {
		return this.native.outputCount();
	}
	public inputNames(): string[] {
		return JSON.parse(this.native.inputNamesJson());
	}
	public outputNames(): string[] {
		return JSON.parse(this.native.outputNamesJson());
	}
	public build(): TypedCircuitExecutorWrapper {
		const executor = TypedCircuitExecutorWrapper.fromNative(this.native.build());
		this.free();
		return executor;
	}
	public buildValidated(): TypedCircuitExecutorWrapper {
		const executor = TypedCircuitExecutorWrapper.fromNative(this.native.buildValidated());
		this.free();
		return executor;
	}
}

export class TypedCircuitExecutorWrapper extends NativeHandle<TypedCircuitExecutor> {
	private inputTypes?: Map<string, string>;

	private constructor(native: TypedCircuitExecutor) {
		super(native);
	}
	static fromNative(native: TypedCircuitExecutor): TypedCircuitExecutorWrapper {
		return new TypedCircuitExecutorWrapper(native);
	}
	static fromInsign(schematic: SchematicWrapper): TypedCircuitExecutorWrapper {
		return this.fromNative(getNucleation().TypedCircuitExecutor.fromInsign(schematic.native));
	}
	static fromInsignWithOptions(
		schematic: SchematicWrapper,
		options: SimulationOptionsWrapper
	): TypedCircuitExecutorWrapper {
		return this.fromNative(
			getNucleation().TypedCircuitExecutor.fromInsignWithOptions(
				schematic.native,
				options.optimize,
				options.io_only
			)
		);
	}
	static fromLayout(
		world: MchprsWorldWrapper,
		layout: IoLayoutWrapper
	): TypedCircuitExecutorWrapper {
		return this.fromNative(
			getNucleation().TypedCircuitExecutor.fromLayout(world.native, layout.native)
		);
	}
	static fromLayoutWithOptions(
		world: MchprsWorldWrapper,
		layout: IoLayoutWrapper,
		options: SimulationOptionsWrapper
	): TypedCircuitExecutorWrapper {
		return this.fromNative(
			getNucleation().TypedCircuitExecutor.fromLayoutWithOptions(
				world.native,
				layout.native,
				options.optimize,
				options.io_only
			)
		);
	}
	public inputNames(): string[] {
		return JSON.parse(this.native.inputNamesJson());
	}
	public outputNames(): string[] {
		return JSON.parse(this.native.outputNamesJson());
	}
	public setStateMode(mode: string): void {
		this.native.setStateMode(mode);
	}
	public reset(): void {
		this.native.reset();
	}
	public tick(ticks: number): void {
		this.native.tick(ticks);
	}
	public flush(): void {
		this.native.flush();
	}
	public setInput(name: string, value: ValueWrapper): void {
		this.native.setInput(name, value.native);
	}
	public readOutput(name: string): ValueWrapper {
		return ValueWrapper.fromNative(this.native.readOutput(name));
	}
	public syncToSchematic(): SchematicWrapper {
		return SchematicWrapper.fromNative(this.native.syncToSchematic(), "owned");
	}
	public getLayoutInfo(): CircuitLayoutInfo {
		const result: {
			inputs: Record<string, { io_type: string; bit_count: number; positions: RegionPosition[] }>;
			outputs: Record<string, { io_type: string; bit_count: number; positions: RegionPosition[] }>;
		} = JSON.parse(this.native.layoutInfoJson());
		const normalize = (entries: typeof result.inputs): Record<string, CircuitLayoutEntry> =>
			Object.fromEntries(
				Object.entries(entries).map(([name, entry]) => [
					name,
					{ ioType: entry.io_type, bitCount: entry.bit_count, positions: entry.positions },
				])
			);
		return { inputs: normalize(result.inputs), outputs: normalize(result.outputs) };
	}
	public execute(inputs: CircuitInputs, mode: ExecutionModeWrapper): CircuitExecutionResult {
		this.inputTypes ??= new Map(
			Object.entries(this.getLayoutInfo().inputs).map(([name, entry]) => [name, entry.ioType])
		);
		const typedInputs = Object.fromEntries(
			Object.entries(inputs).map(([name, value]) => {
				if (value instanceof ValueWrapper)
					return [name, { type: value.typeName(), value: value.toJs() }];
				if (typeof value === "object") return [name, value];
				const ioType = this.inputTypes?.get(name) ?? "";
				let type: string;
				if (typeof value === "boolean") type = "bool";
				else if (typeof value === "string") type = "string";
				else if (ioType.startsWith("Float32") || !Number.isInteger(value)) type = "f32";
				else if (ioType.startsWith("SignedInt") || value < 0) type = "i32";
				else type = "u32";
				return [name, { type, value }];
			})
		);
		const result: {
			outputs: Record<string, CircuitValue>;
			ticks_elapsed: number;
			condition_met: boolean;
		} = JSON.parse(this.native.execute(JSON.stringify(typedInputs), mode.native));
		return {
			outputs: Object.fromEntries(
				Object.entries(result.outputs).map(([name, value]) => [name, value.value])
			),
			ticksElapsed: result.ticks_elapsed,
			conditionMet: result.condition_met,
		};
	}
	public run(inputs: CircuitInputs, limit: number, mode: string): CircuitExecutionResult {
		let executionMode: ExecutionModeWrapper;
		switch (mode) {
			case "fixed":
			case "fixed_ticks":
				executionMode = ExecutionModeWrapper.fixedTicks(limit);
				break;
			case "stable":
			case "until_stable":
				executionMode = ExecutionModeWrapper.untilStable(2, limit);
				break;
			case "change":
			case "until_change":
				executionMode = ExecutionModeWrapper.untilChange(limit, 1);
				break;
			default:
				throw new Error(`Unknown circuit execution mode: ${mode}`);
		}
		try {
			return this.execute(inputs, executionMode);
		} finally {
			executionMode.free();
		}
	}
}
