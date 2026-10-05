import { beforeAll, describe, expect, it, vi } from "vitest";
import { SchematicWrapper } from "./SchematicWrapper";
import { readRenderSnapshot } from "./chunks";
import { initializeNucleationWasm } from "./runtime";

vi.unmock("nucleation");

beforeAll(() => initializeNucleationWasm());

describe("native schematic ownership", () => {
	it("releases owned contents when supported and invalidates cached render data", () => {
		const schematic = new SchematicWrapper();
		schematic.set_block(0, 0, 0, "minecraft:stone");
		const native = schematic.native;
		const supportsEarlyRelease = typeof Reflect.get(native, "clearContents") === "function";
		const before = readRenderSnapshot(native);
		schematic.free();
		schematic.free();
		expect(() => schematic.native).toThrow("Schematic has been freed");
		// The native alias remains valid: the finalizer still owns its opaque handle.
		expect(native.blockCount()).toBe(supportsEarlyRelease ? 0 : 1);
		expect(readRenderSnapshot(native)).not.toBe(before);
	});

	it("never clears a native handle borrowed from another owner", () => {
		const owner = new SchematicWrapper();
		owner.set_block(0, 0, 0, "minecraft:stone");
		const borrowed = SchematicWrapper.fromNative(owner.native);
		borrowed.free();
		expect(owner.get_block(0, 0, 0)).toBe("minecraft:stone");
		owner.free();
	});

	it("preserves the owner's active chunk iterator when a borrowed wrapper is freed", () => {
		const owner = new SchematicWrapper();
		owner.set_block(0, 0, 0, "minecraft:stone");
		const iterator = owner.create_lazy_chunk_iterator(16, 16, 16, "bottom_up", 0, 0, 0);
		const borrowed = SchematicWrapper.fromNative(owner.native);
		borrowed.free();
		expect(iterator.next()?.blocks).toEqual(new Int32Array([0, 0, 0, 1]));
		iterator.free();
		owner.free();
	});

	it("clears an explicitly adopted clone independently of its source", () => {
		const owner = new SchematicWrapper();
		owner.set_block(0, 0, 0, "minecraft:stone");
		const clone = owner.native.deepClone();
		const supportsEarlyRelease = typeof Reflect.get(clone, "clearContents") === "function";
		const adopted = SchematicWrapper.fromNative(clone, "owned");
		adopted.free();
		expect(clone.blockCount()).toBe(supportsEarlyRelease ? 0 : 1);
		expect(owner.get_block(0, 0, 0)).toBe("minecraft:stone");
		owner.free();
	});

	it("owns replacement parses while preserving the previous borrowed source", () => {
		const source = new SchematicWrapper();
		source.set_block(0, 0, 0, "minecraft:stone");
		const borrowed = SchematicWrapper.fromNative(source.native);
		borrowed.fromSnapshot(source.toSnapshot());
		const parsed = borrowed.native;
		const supportsEarlyRelease = typeof Reflect.get(parsed, "clearContents") === "function";
		borrowed.free();
		expect(parsed.blockCount()).toBe(supportsEarlyRelease ? 0 : 1);
		expect(source.get_block(0, 0, 0)).toBe("minecraft:stone");
		source.free();
	});

	it("releases previous owned storage when replacing a parsed schematic", () => {
		const schematic = new SchematicWrapper();
		schematic.set_block(0, 0, 0, "minecraft:stone");
		const previous = schematic.native;
		const supportsEarlyRelease = typeof Reflect.get(previous, "clearContents") === "function";
		const snapshot = schematic.toSnapshot();
		schematic.fromSnapshot(snapshot);
		expect(schematic.native).not.toBe(previous);
		expect(previous.blockCount()).toBe(supportsEarlyRelease ? 0 : 1);
		expect(schematic.get_block(0, 0, 0)).toBe("minecraft:stone");
		schematic.free();
	});
});
