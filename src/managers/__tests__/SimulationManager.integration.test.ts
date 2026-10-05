import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { SimulationManager } from "../SimulationManager";
import { SchematicWrapper } from "../../nucleation/SchematicWrapper";

vi.unmock("nucleation");

import { initializeNucleationWasm } from "../../nucleation/runtime";
beforeAll(() => initializeNucleationWasm());

const managers: SimulationManager[] = [];

function createManager() {
	const events = new EventEmitter();
	const manager = new SimulationManager(events);
	managers.push(manager);
	return { manager, events };
}

function createCircuit() {
	const schematic = new SchematicWrapper();
	schematic.set_block(0, 0, 0, "minecraft:stone");
	schematic.set_block_from_string(
		0,
		1,
		0,
		"minecraft:lever[face=floor,facing=north,powered=false]"
	);
	schematic.set_block_from_string(1, 1, 0, "minecraft:redstone_lamp[lit=false]");
	return schematic;
}

afterEach(() => {
	for (const manager of managers.splice(0)) manager.destroy();
	vi.useRealTimers();
});

describe("native Nucleation simulation", () => {
	it("preserves legacy world methods, boolean results and explicit disposal", () => {
		const world = createCircuit().create_simulation_world();
		expect(world.get_lever_power(0, 1, 0)).toBe(false);
		world.on_use_block(0, 1, 0);
		world.tick(20);
		world.flush();
		expect(world.is_lit(1, 1, 0)).toBe(true);
		const updated = world.into_schematic();
		expect(updated.get_block_string(1, 1, 0)).toBe("minecraft:redstone_lamp[lit=true]");
		expect(() => world.get_schematic()).toThrow("Simulation world has been freed");
		world.free();
	});

	it("syncs a real lever/lamp interaction with one event and accurate tick counts", async () => {
		const { manager, events } = createManager();
		const schematic = createCircuit();
		expect(await manager.initializeSimulation(schematic)).toBe(true);
		const synced = vi.fn();
		const interacted = vi.fn();
		events.on("simulationSynced", synced);
		events.on("blockInteracted", interacted);
		const updated = await manager.interactWithBlock(0, 1, 0);
		expect(updated?.get_block_string(1, 1, 0)).toBe("minecraft:redstone_lamp[lit=true]");
		expect(manager.getState().tickCount).toBe(20);
		expect(synced).toHaveBeenCalledOnce();
		expect(synced).toHaveBeenCalledWith({
			tickCount: 20,
			sourceSchematic: schematic,
			updatedSchematic: updated,
		});
		expect(interacted).toHaveBeenCalledWith({ position: [0, 1, 0], tickCount: 20 });
		expect(manager.ownsSchematic(updated ?? schematic)).toBe(true);
		expect(manager.ownsSchematic(schematic)).toBe(false);
	});

	it("preserves headless batching and emits only the explicitly requested sync", async () => {
		const { manager, events } = createManager();
		expect(await manager.initializeSimulation(createCircuit(), { syncMode: "headless" })).toBe(
			true
		);
		const synced = vi.fn();
		events.on("simulationSynced", synced);
		manager.tick(100);
		expect(synced).not.toHaveBeenCalled();
		expect(manager.syncToSchematic()).not.toBeNull();
		expect(synced).toHaveBeenCalledOnce();
		expect(manager.getState().tickCount).toBe(100);
	});

	it("detects the first custom IO change and preserves callback power values", async () => {
		const { manager } = createManager();
		const schematic = new SchematicWrapper();
		schematic.set_block(0, 0, 0, "minecraft:stone");
		schematic.set_block_from_string(0, 1, 0, "minecraft:redstone_wire[power=0]");
		expect(
			await manager.initializeSimulation(schematic, { customIo: [{ x: 0, y: 1, z: 0 }] })
		).toBe(true);
		const callback = vi.fn();
		manager.onCustomIoChange(0, 1, 0, callback);
		expect(manager.setSignalStrength(0, 1, 0, 12)).toBe(true);
		expect(manager.getSignalStrength(0, 1, 0)).toBe(12);
		expect(callback).toHaveBeenCalledWith({ x: 0, y: 1, z: 0, power: 12, tick: 0 });
	});

	it("does not resurrect a simulation destroyed during asynchronous initialization", async () => {
		const { manager, events } = createManager();
		const initialized = vi.fn();
		events.on("simulationInitialized", initialized);
		const ready = manager.initializeSimulation(createCircuit());
		manager.destroy();
		expect(await ready).toBe(false);
		expect(manager.isSimulationActive()).toBe(false);
		expect(initialized).not.toHaveBeenCalled();
	});
});
