import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	BlockPosition,
	CircuitBuilderWrapper,
	DefinitionRegionWrapper,
	ExecutionModeWrapper,
	IoLayoutBuilderWrapper,
	IoTypeWrapper,
	LayoutFunctionWrapper,
	MchprsWorldWrapper,
	SchematicWrapper,
	SortStrategyWrapper,
	TypedCircuitExecutorWrapper,
	ValueWrapper,
	initializeNucleationWasm,
} from "../nucleationExports";

vi.unmock("nucleation");
vi.unmock("../nucleationExports");

beforeAll(async () => {
	await initializeNucleationWasm();
});

function leverSchematic(): SchematicWrapper {
	const schematic = new SchematicWrapper();
	schematic.set_block(0, 0, 0, "minecraft:lever[face=floor,facing=north,powered=false]");
	return schematic;
}

describe("Nucleation region compatibility", () => {
	it("preserves fluent edits, metadata, boxes and independent region copies", () => {
		const region = DefinitionRegionWrapper.fromBounds(
			new BlockPosition(0, 1, 2),
			new BlockPosition(2, 3, 4)
		).setMetadata("label", "test");
		const copy = region.copy().shift(10, 0, 0);
		expect(region.getBounds()).toEqual({ min: [0, 1, 2], max: [2, 3, 4] });
		expect(copy.getBounds()).toEqual({ min: [10, 1, 2], max: [12, 3, 4] });
		expect(region.getAllMetadata()).toEqual({ label: "test" });
		expect(region.getMetadata("missing")).toBeNull();
		expect(region.volume()).toBe(27);
		expect(region.dimensions()).toEqual([3, 3, 3]);
		expect(region.getBoxes()).toEqual([region.getBounds()]);
		expect(region.getBox(99)).toBeNull();
		region.free();
		region.free();
		expect(() => region.volume()).toThrow("freed");
		expect(copy.volume()).toBe(27);
		copy.free();
	});

	it("keeps the legacy YXZ position order and empty-region results", () => {
		const region = DefinitionRegionWrapper.fromPositions([
			[1, 0, 0],
			[0, 0, 1],
			[0, 1, 0],
		]);
		expect(region.positionsSorted()).toEqual([
			[0, 0, 1],
			[1, 0, 0],
			[0, 1, 0],
		]);
		const empty = new DefinitionRegionWrapper();
		expect(empty.getBounds()).toBeNull();
		expect(empty.center()).toBeNull();
		expect(empty.centerF32()).toBeNull();
		expect(empty.dimensions()).toEqual([0, 0, 0]);
		region.free();
		empty.free();
	});

	it("persists attached region edits without letting independent copies modify their source", () => {
		const schematic = leverSchematic();
		const region = schematic.createRegion("selection", [0, 0, 0], [1, 0, 0]);
		region.shift(4, 0, 0).setMetadata("color", "#00ff88");
		const stored = schematic.getDefinitionRegion("selection");
		expect(stored.getBounds()).toEqual({ min: [4, 0, 0], max: [5, 0, 0] });
		expect(stored.getMetadata("color")).toBe("#00ff88");
		const copy = stored.copy().shift(10, 0, 0);
		const unchanged = schematic.getDefinitionRegion("selection");
		expect(unchanged.getBounds()).toEqual(stored.getBounds());
		copy.free();
		unchanged.free();
		stored.free();
		region.free();
		schematic.free();
	});

	it("filters real schematic blocks and retains the attached schematic in copies", () => {
		const schematic = leverSchematic();
		schematic.set_block(1, 0, 0, "minecraft:stone");
		const region = DefinitionRegionWrapper.fromBounds(
			new BlockPosition(0, 0, 0),
			new BlockPosition(1, 0, 0)
		);
		const filtered = region.filterByBlock(schematic, "minecraft:lever");
		expect(filtered.positions()).toEqual([[0, 0, 0]]);
		expect(filtered.getBlocks()).toEqual([
			expect.objectContaining({ x: 0, y: 0, z: 0, block: "minecraft:lever" }),
		]);
		const copy = filtered.copy().excludeBlock("minecraft:lever");
		expect(copy.isEmpty()).toBe(true);
		copy.free();
		filtered.free();
		region.free();
		schematic.free();
	});
});

describe("Nucleation circuit compatibility", () => {
	it("executes a real circuit with primitive inputs and legacy result/layout shapes", () => {
		const schematic = leverSchematic();
		const region = DefinitionRegionWrapper.fromPositions([[0, 0, 0]]);
		const type = IoTypeWrapper.unsignedInt(1);
		const builder = new CircuitBuilderWrapper(schematic)
			.withInputAuto("input", type, region)
			.withOutputAuto("output", type, region);
		expect(builder.inputNames()).toEqual(["input"]);
		expect(builder.outputCount()).toBe(1);
		const executor = builder.build();
		const mode = ExecutionModeWrapper.fixedTicks(1);
		expect(executor.getLayoutInfo()).toMatchObject({
			inputs: { input: { ioType: "UnsignedInt { bits: 1 }", bitCount: 1, positions: [[0, 0, 0]] } },
		});
		expect(executor.execute({ input: 1 }, mode)).toEqual({
			outputs: { output: 1 },
			ticksElapsed: 1,
			conditionMet: true,
		});
		expect(executor.readOutput("output").toJs()).toBe(1);
		expect(executor.run({ input: 0 }, 1, "fixed").outputs).toEqual({ output: 0 });
		const synced = executor.syncToSchematic();
		expect(synced.get_block(0, 0, 0)).toContain("minecraft:lever");
		synced.free();
		executor.free();
		mode.free();
		type.free();
		region.free();
		schematic.free();
	});

	it("honors custom bit sorting and signed inputs with positive and negative values", () => {
		const schematic = leverSchematic();
		schematic.set_block(2, 0, 0, "minecraft:lever[face=floor,facing=north,powered=false]");
		const region = DefinitionRegionWrapper.fromPositions([
			[0, 0, 0],
			[2, 0, 0],
		]);
		const type = IoTypeWrapper.signedInt(2);
		const sort = SortStrategyWrapper.xDescYZ();
		expect(sort.name).toBe("x_desc_y_z");
		const executor = new CircuitBuilderWrapper(schematic)
			.withInputAutoSorted("input", type, region, sort)
			.withOutputAutoSorted("output", type, region, sort)
			.build();
		expect(executor.getLayoutInfo().inputs.input.positions).toEqual([
			[2, 0, 0],
			[0, 0, 0],
		]);
		expect(executor.run({ input: 1 }, 1, "fixed").outputs.output).toBe(1);
		expect(executor.run({ input: -1 }, 1, "fixed").outputs.output).toBe(-1);
		executor.free();
		type.free();
		sort.free();
		region.free();
		schematic.free();
	});

	it("builds IO layouts from BlockPosition objects and accepts wrapped boolean values", () => {
		const schematic = leverSchematic();
		const world = new MchprsWorldWrapper(schematic);
		const type = IoTypeWrapper.boolean();
		const positions = [new BlockPosition(0, 0, 0)];
		const layoutFunction = LayoutFunctionWrapper.oneToOne();
		const layout = new IoLayoutBuilderWrapper()
			.addInput("input", type, layoutFunction, positions)
			.addOutputAuto("output", type, positions)
			.build();
		expect(layout.inputNames()).toEqual(["input"]);
		const executor = TypedCircuitExecutorWrapper.fromLayout(world, layout);
		const value = ValueWrapper.fromBool(true);
		expect(executor.run({ input: value }, 1, "fixed").outputs.output).toBe(true);
		expect(executor.readOutput("output").toJs()).toBe(true);
		value.free();
		executor.free();
		layout.free();
		layoutFunction.free();
		type.free();
		world.free();
		schematic.free();
	});
});
