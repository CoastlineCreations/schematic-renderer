type NucleationModule = typeof import("nucleation");

let runtime: NucleationModule | undefined;
let initialization: Promise<void> | undefined;

/** Load the shared WASM module only when requested, including from CommonJS bundles. */
export function initializeNucleationWasm(): Promise<void> {
	if (runtime) return Promise.resolve();
	initialization ??= (async () => {
		const host: typeof globalThis & { Nucleation?: NucleationModule } = globalThis;
		runtime = host.Nucleation ?? (await import("nucleation"));
	})().catch((error: unknown) => {
		initialization = undefined;
		throw error;
	});
	return initialization;
}

/** Synchronous adapter methods require the same explicit initialization as the legacy API. */
export function getNucleation(): NucleationModule {
	if (!runtime) {
		throw new Error("Nucleation is not initialized. Await initializeNucleationWasm() first.");
	}
	return runtime;
}
