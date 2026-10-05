import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { SchematicRenderer } from "./SchematicRenderer";
import { SimulationManager } from "./managers/SimulationManager";
import type { SchematicObject } from "./managers/SchematicObject";

afterEach(() => vi.useRealTimers());

describe("SchematicRenderer simulation controls", () => {
	function rendererFixture() {
		const renderer = Object.create(SchematicRenderer.prototype) as SchematicRenderer;
		const target = { schematicWrapper: {}, rebuildMesh: vi.fn().mockResolvedValue(undefined) };
		const other = { schematicWrapper: {}, rebuildMesh: vi.fn().mockResolvedValue(undefined) };
		const onSimulationSynced = vi.fn();
		renderer.options = {
			simulationOptions: { enableSimulation: true },
			callbacks: { onSimulationSynced },
		};
		renderer.eventEmitter = new EventEmitter();
		renderer.schematicManager = {
			getAllSchematics: () => [other, target],
			getFirstSchematic: () => other,
		} as unknown as SchematicRenderer["schematicManager"];
		const initialize = Reflect.get(renderer, "initializeInteractionComponents") as () => void;
		initialize.call(renderer);
		const manager = renderer.simulationManager;
		if (!manager) throw new Error("Simulation manager missing");
		const updated = {} as SchematicObject["schematicWrapper"];
		vi.spyOn(manager, "syncToSchematic").mockImplementation(() => {
			renderer.eventEmitter.emit("simulationSynced", {
				sourceSchematic: target.schematicWrapper,
				updatedSchematic: updated,
			});
			return updated;
		});
		return { renderer, manager, target, other, updated, onSimulationSynced };
	}

	it("rebuilds only the simulated schematic once and awaits the rebuild", async () => {
		const { renderer, target, other, updated, onSimulationSynced } = rendererFixture();
		let complete!: () => void;
		target.rebuildMesh.mockReturnValue(
			new Promise<void>((resolve) => {
				complete = resolve;
			})
		);
		let finished = false;
		const sync = renderer.syncSimulation().then(() => {
			finished = true;
		});
		await Promise.resolve();
		expect(target.schematicWrapper).toBe(updated);
		expect(target.rebuildMesh).toHaveBeenCalledOnce();
		expect(other.rebuildMesh).not.toHaveBeenCalled();
		expect(onSimulationSynced).toHaveBeenCalledOnce();
		expect(finished).toBe(false);
		complete();
		await sync;
		expect(finished).toBe(true);
		renderer.blockInteractionHandler?.dispose();
	});

	it("still rebuilds and calls callbacks for direct manager synchronization", () => {
		const { renderer, manager, target, other, updated, onSimulationSynced } = rendererFixture();
		expect(manager.syncToSchematic()).toBe(updated);
		expect(target.rebuildMesh).toHaveBeenCalledOnce();
		expect(other.rebuildMesh).not.toHaveBeenCalled();
		expect(onSimulationSynced).toHaveBeenCalledOnce();
		renderer.blockInteractionHandler?.dispose();
		expect(renderer.eventEmitter.listenerCount("interactBlock")).toBe(0);
	});

	it("coalesces ticks while a mesh builds without starving active rebuilds or their waiters", async () => {
		const { renderer, target } = rendererFixture();
		let finishFirst!: () => void;
		let finishNext!: () => void;
		target.rebuildMesh
			.mockReturnValueOnce(
				new Promise<void>((resolve) => {
					finishFirst = resolve;
				})
			)
			.mockReturnValueOnce(
				new Promise<void>((resolve) => {
					finishNext = resolve;
				})
			);
		const first = renderer.syncSimulation();
		const next = renderer.syncSimulation();
		const latest = renderer.syncSimulation();
		expect(target.rebuildMesh).toHaveBeenCalledOnce();
		finishFirst();
		await first;
		await Promise.resolve();
		expect(target.rebuildMesh).toHaveBeenCalledTimes(2);
		finishNext();
		await Promise.all([next, latest]);
		expect(target.rebuildMesh).toHaveBeenCalledTimes(2);
		renderer.blockInteractionHandler?.dispose();
	});

	it("stops automatic ticks while preserving the running simulation and IO state", () => {
		vi.useFakeTimers();
		const manager = new SimulationManager(new EventEmitter());
		const free = vi.fn();
		Reflect.set(manager, "simulationWorld", { free });
		Reflect.set(manager, "state", {
			isRunning: true,
			tickCount: 21,
			autoTickEnabled: false,
			tickSpeed: 20,
			syncMode: "headless",
			customIoPositions: [{ x: 1, y: 2, z: 3 }],
		});
		const renderer = Object.create(SchematicRenderer.prototype) as SchematicRenderer;
		renderer.simulationManager = manager;
		renderer.startAutoTick();
		expect(vi.getTimerCount()).toBe(1);
		renderer.stopAutoTick();
		expect(vi.getTimerCount()).toBe(0);
		expect(manager.getState()).toMatchObject({
			autoTickEnabled: false,
			isRunning: true,
			tickCount: 21,
			customIoPositions: [{ x: 1, y: 2, z: 3 }],
		});
		expect(free).not.toHaveBeenCalled();
		manager.destroy();
	});
});
