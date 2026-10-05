/** Chromium's optional, non-standard JavaScript heap statistics. */
export interface HeapMemoryInfo {
	readonly totalJSHeapSize: number;
	readonly jsHeapSizeLimit: number;
	readonly usedJSHeapSize: number;
}

export type PerformanceWithMemory = Performance & { readonly memory?: HeapMemoryInfo };
