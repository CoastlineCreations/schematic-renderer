import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	initializeNucleationWasm as initNucleation,
	SchematicWrapper,
} from "../../nucleationExports";
import { InsignManager } from "../InsignManager";
import type { SchematicRenderer } from "../../SchematicRenderer";

vi.unmock("nucleation");
vi.unmock("../../nucleationExports");

function managerFor(data: unknown): InsignManager {
	const schematic = { compileInsign: () => data };
	return new InsignManager({
		schematicManager: {
			getAllSchematics: () => [schematic],
			getSchematic: () => schematic,
		},
	} as unknown as SchematicRenderer);
}

describe("Insign data normalization", () => {
	beforeAll(async () => {
		await initNucleation();
	});

	it("loads real WASM Maps, including global entries without bounding boxes", async () => {
		const schematic = new SchematicWrapper();
		try {
			schematic.setBlockWithNbt(0, 0, 0, "minecraft:oak_sign", {
				id: "minecraft:sign",
				Text1: JSON.stringify({ text: "#$global:version=1" }),
				Text2: JSON.stringify({ text: "@test=ac([0,0,0],[1,1,1])" }),
				Text3: JSON.stringify({ text: '#doc.label="Test"' }),
				Text4: JSON.stringify({ text: "" }),
			});
			const manager = managerFor(schematic.compileInsign());
			await expect(manager.loadFromSchematic()).resolves.toEqual({
				$global: { metadata: { version: 1 } },
				test: {
					bounding_boxes: [
						[
							[0, 0, 0],
							[1, 1, 1],
						],
					],
					metadata: { "doc.label": "Test" },
				},
			});
			expect(
				manager.getFilteredRegions({ metadata: { "doc.label": "Test" } }).map((region) => region.id)
			).toEqual(["test"]);
		} finally {
			schematic.free();
		}
	});

	it("accepts plain objects and absent or null geometry while retaining JSON metadata", async () => {
		const metadata = {
			enabled: true,
			weight: 2,
			label: "Global",
			extra: null,
			tags: ["one"],
			nested: { value: 3 },
		};
		const manager = managerFor({ $global: { bounding_boxes: null, metadata } });
		await expect(manager.loadFromSchematic()).resolves.toEqual({ $global: { metadata } });
	});

	it("reports malformed geometry before highlights consume it", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const manager = managerFor({
				broken: {
					bounding_boxes: [
						[
							[0, 1],
							[2, 3, 4],
						],
					],
					metadata: {},
				},
			});
			await expect(manager.loadFromSchematic()).resolves.toBeNull();
			expect(error).toHaveBeenCalledWith(
				"[InsignManager] Failed to compile Insign data:",
				expect.objectContaining({ message: "Invalid Insign bounding boxes: broken" })
			);
		} finally {
			error.mockRestore();
		}
	});
});
