import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	DiffWrapper,
	SchematicBuilderWrapper,
	SchematicWrapper,
	initializeNucleationWasm,
} from "../nucleationExports";

vi.unmock("nucleation");
vi.unmock("../nucleationExports");

beforeAll(async () => {
	await initializeNucleationWasm();
});

describe("Nucleation schematic compatibility", () => {
	it("builds layered schematics with a custom palette and exports reusable templates", () => {
		const builder = new SchematicBuilderWrapper()
			.name("Builder regression")
			.palette({ s: "minecraft:stone", g: "minecraft:gold_block" })
			.layer(["sg"])
			.layers([["gs"]])
			.offset(4, 2, 3);
		builder.validate();
		const template = builder.toTemplate();
		const schematic = builder.build();
		expect(schematic.getName()).toBe("Builder regression");
		expect(schematic.get_block_count()).toBe(4);
		expect(schematic.get_block(4, 2, 3)).toBe("minecraft:stone");
		expect(schematic.get_block(5, 2, 3)).toBe("minecraft:gold_block");
		expect(schematic.get_block(4, 3, 3)).toBe("minecraft:gold_block");
		expect(schematic.get_bounding_box()).toMatchObject({ min: [4, 2, 3], max: expect.any(Array) });
		expect(schematic.get_region_bounding_box(schematic.get_region_names()[0])).toMatchObject({
			min: [4, 2, 3],
			max: expect.any(Array),
		});
		const reconstructedBuilder = SchematicBuilderWrapper.fromTemplate(template).offset(4, 2, 3);
		const reconstructed = reconstructedBuilder.build();
		expect(reconstructed.get_block_count()).toBe(4);
		expect(reconstructed.get_block(5, 3, 3)).toBe("minecraft:stone");
		expect(() => builder.build()).toThrow("AlreadyConsumed");
		reconstructed.free();
		reconstructedBuilder.free();
		schematic.free();
		builder.free();
	});

	it.each(["schematic", "litematic"] as const)(
		"preserves nested typed NBT and block properties through %s export/import",
		(format) => {
			const schematic = new SchematicWrapper();
			schematic.set_block(0, 0, 0, "minecraft:chest[facing=west,type=single,waterlogged=false]");
			schematic.setBlockEntity(
				0,
				0,
				0,
				"minecraft:chest",
				'{CustomName:"Storage",Items:[{Slot:0b,id:"minecraft:stone",Count:3b}],Custom:{label:"nested",values:[I;1,2,3]}}'
			);
			const original = schematic.get_block_entity(0, 0, 0);
			if (!original) throw new Error("Fixture block entity was not created");
			expect(original.nbt).toMatchObject({
				Items: { List: [{ Compound: { Count: { Byte: 3 }, Slot: { Byte: 0 } } }] },
				Custom: { Compound: { values: { IntArray: [1, 2, 3] } } },
			});
			const restored = new SchematicWrapper();
			if (format === "schematic") restored.from_schematic(schematic.to_schematic());
			else restored.from_litematic(schematic.to_litematic());
			expect(restored.get_block_entity(0, 0, 0)).toMatchObject(original);
			expect(restored.get_block_with_properties(0, 0, 0)?.properties()).toMatchObject({
				facing: "west",
				type: "single",
				waterlogged: "false",
			});
			restored.free();
			schematic.free();
		}
	);

	it("preserves the legacy string NBT helper and rejects unsupported values before mutation", () => {
		const schematic = new SchematicWrapper();
		schematic.setBlockWithNbt(0, 0, 0, "minecraft:chest", {
			id: "minecraft:chest",
			CustomName: "Original chest",
		});
		expect(() =>
			schematic.setBlockWithNbt(0, 0, 0, "minecraft:chest", {
				CustomName: "Replacement",
				Items: [{ Count: 3 }],
			})
		).toThrow("NBT values should be strings");
		expect(schematic.get_block_entity(0, 0, 0)).toMatchObject({
			nbt: { CustomName: { String: "Original chest" } },
		});
		schematic.free();
	});
});

describe("Nucleation diff compatibility", () => {
	it("returns legacy numeric distance and JSON methods, including a complete mixed region", () => {
		const before = new SchematicWrapper();
		const after = new SchematicWrapper();
		for (const schematic of [before, after]) {
			schematic.set_block(10, 0, 0, "minecraft:stone");
			schematic.set_block(20, 0, 0, "minecraft:dirt");
		}
		before.set_block(0, 0, 0, "minecraft:stone");
		before.set_block(1, 0, 0, "minecraft:stone");
		after.set_block(1, 0, 0, "minecraft:glass");
		after.set_block(2, 0, 0, "minecraft:gold_block");
		const diff = before.diff(after, "exact");
		expect(diff.distance).toBe(3);
		expect(JSON.parse(diff.summaryJson())).toMatchObject({
			counts: { added: 1, removed: 1, swapped: 1, changed: 0 },
		});
		expect(JSON.parse(diff.regionsJson())).toEqual([
			{ min: [0, 0, 0], max: [2, 0, 0], kind: "mixed", count: 3 },
		]);
		const restored = DiffWrapper.fromJson(diff.toJson());
		expect(restored.distance).toBe(diff.distance);
		expect(restored.regionsJson()).toBe(diff.regionsJson());
		const added = restored.added();
		expect(added.get_block(2, 0, 0)).toBe("minecraft:gold_block");
		added.free();
		restored.free();
		diff.free();
		before.free();
		after.free();
	});

	it("returns all disjoint regions rather than the truncated native summary", () => {
		const positions = Array.from({ length: 600 }, (_, index) => [index * 2, 0, 0]);
		const diff = DiffWrapper.fromJson(
			JSON.stringify({
				added: positions.map((pos) => ({ pos, block: "minecraft:stone" })),
				changed: [],
				removed: [],
				swapped: [],
				distance: positions.length,
				palette_swaps: [],
				schema: "nucleation.diff/1",
				support: 1,
				transform: { rotate: { steps: [] }, translate: [0, 0, 0] },
			})
		);
		expect(JSON.parse(diff.regionsJson())).toHaveLength(600);
		diff.free();
	});
});
