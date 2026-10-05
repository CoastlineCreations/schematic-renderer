import { describe, expect, it, vi } from "vitest";
import { SchematicRendererContext } from "./SchematicRendererContext";

vi.mock("./workers/MeshBuilder.worker?worker&inline", () => ({ default: class {} }));
vi.mock("./workers/MeshBuilderWasm.worker?worker&inline", () => ({ default: class {} }));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((complete, fail) => {
		resolve = complete;
		reject = fail;
	});
	return { promise, resolve, reject };
}

describe("shared context registry lifecycle", () => {
	it("disposes a context released while its factory is still pending", async () => {
		const build = deferred<SchematicRendererContext>();
		const context = { dispose: vi.fn() } as unknown as SchematicRendererContext;
		const key = "lifecycle-pending";
		const acquired = SchematicRendererContext.acquire(key, () => build.promise);
		SchematicRendererContext.release(key, { dispose: true });
		build.resolve(context);
		await acquired;
		await Promise.resolve();
		expect(context.dispose).toHaveBeenCalledOnce();
		expect(SchematicRendererContext.peek(key)).toBeUndefined();
	});

	it("a retired failed factory cannot evict the replacement context", async () => {
		const oldBuild = deferred<SchematicRendererContext>();
		const key = "lifecycle-replacement";
		const old = SchematicRendererContext.acquire(key, () => oldBuild.promise);
		const rejected = expect(old).rejects.toThrow("failed");
		SchematicRendererContext.release(key, { dispose: true });
		const replacement = { dispose: vi.fn() } as unknown as SchematicRendererContext;
		await SchematicRendererContext.acquire(key, async () => replacement);
		oldBuild.reject(new Error("failed"));
		await rejected;
		expect(SchematicRendererContext.peek(key)).toBe(replacement);
		SchematicRendererContext.release(key, { dispose: true });
	});
});
