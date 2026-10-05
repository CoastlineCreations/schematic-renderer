/** Diplomat owns native allocations through FinalizationRegistry. Release references on teardown. */
export abstract class NativeHandle<T> {
	private handle: T | undefined;

	protected constructor(native: T) {
		this.handle = native;
	}

	public get native(): T {
		if (this.handle === undefined) throw new Error("Nucleation object has been freed");
		return this.handle;
	}

	protected replaceNative(native: T): void {
		this.handle = native;
	}

	public free(): void {
		this.handle = undefined;
	}

	public [Symbol.dispose](): void {
		this.free();
	}
}
