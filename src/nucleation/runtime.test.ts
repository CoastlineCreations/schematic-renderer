import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
	vi.resetModules();
	vi.unstubAllGlobals();
	vi.doUnmock("nucleation");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.doUnmock("nucleation");
});

describe("Nucleation runtime initialization", () => {
	it("keeps package loading lazy and shares concurrent initialization", async () => {
		const loaded = vi.fn();
		vi.doMock("nucleation", () => {
			loaded();
			return { Schematic: { create: vi.fn() } };
		});
		const { getNucleation, initializeNucleationWasm } = await import("./runtime");
		expect(loaded).not.toHaveBeenCalled();
		expect(getNucleation).toThrow("Await initializeNucleationWasm() first");
		const first = initializeNucleationWasm();
		const second = initializeNucleationWasm();
		expect(first).toBe(second);
		await Promise.all([first, second]);
		expect(loaded).toHaveBeenCalledOnce();
		expect(getNucleation().Schematic.create).toBeTypeOf("function");
		await initializeNucleationWasm();
		expect(loaded).toHaveBeenCalledOnce();
	});

	it("uses the browser UMD namespace without importing the package", async () => {
		const imported = vi.fn();
		vi.doMock("nucleation", () => {
			imported();
			throw new Error("Package import should not run");
		});
		const namespace = { Schematic: { create: vi.fn() } };
		vi.stubGlobal("Nucleation", namespace);
		const { getNucleation, initializeNucleationWasm } = await import("./runtime");
		await initializeNucleationWasm();
		expect(getNucleation()).toBe(namespace);
		expect(imported).not.toHaveBeenCalled();
	});

	it("allows another initialization attempt after a rejected import", async () => {
		vi.doMock("nucleation", () => {
			throw new Error("Temporary initialization failure");
		});
		const { getNucleation, initializeNucleationWasm } = await import("./runtime");
		await expect(initializeNucleationWasm()).rejects.toThrow();
		expect(getNucleation).toThrow("not initialized");
		const namespace = { Schematic: { create: vi.fn() } };
		vi.doMock("nucleation", () => namespace);
		await initializeNucleationWasm();
		expect(getNucleation().Schematic).toBe(namespace.Schematic);
	});
});
