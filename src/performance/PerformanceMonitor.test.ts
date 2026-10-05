import { afterEach, describe, expect, it, vi } from "vitest";
import { performanceMonitor } from "./PerformanceMonitor";

afterEach(() => {
	performanceMonitor.clearAllSessions();
	performanceMonitor.setRenderer(null);
	vi.unstubAllGlobals();
});

describe("PerformanceMonitor renderer statistics", () => {
	it.each([
		{
			backend: "WebGL",
			info: {
				render: { calls: 7, triangles: 12, points: 0, lines: 0 },
				memory: { geometries: 2, textures: 3 },
				programs: [{}, {}],
			},
		},
		{
			backend: "WebGPU",
			info: {
				render: { calls: 100, drawCalls: 7, triangles: 12, points: 0, lines: 0 },
				memory: { geometries: 2, textures: 3, programs: 2 },
			},
		},
	])("captures per-frame statistics from $backend", ({ info }) => {
		performanceMonitor.setRenderer({ info });
		const sessionId = performanceMonitor.startSession("test", "incremental");
		expect(performanceMonitor.endSession(sessionId)?.rendererStats).toEqual({
			drawCalls: 7,
			triangles: 12,
			points: 0,
			lines: 0,
			geometries: 2,
			textures: 3,
			programs: 2,
		});
	});
});

describe("PerformanceMonitor heap snapshots", () => {
	it("reads Chromium's totalJSHeapSize instead of the nonexistent jsHeapSize field", () => {
		vi.stubGlobal("performance", {
			now: () => 123,
			memory: {
				totalJSHeapSize: 4096,
				usedJSHeapSize: 2048,
				jsHeapSizeLimit: 8192,
			},
		});

		expect(performanceMonitor.takeMemorySnapshot("heap")).toMatchObject({
			timestamp: 123,
			jsHeapSize: 4096,
			usedJSHeapSize: 2048,
			jsHeapSizeLimit: 8192,
		});
	});

	it("keeps heap statistics at zero when the browser does not expose them", () => {
		vi.stubGlobal("performance", { now: () => 123 });

		expect(performanceMonitor.takeMemorySnapshot("unsupported")).toMatchObject({
			jsHeapSize: 0,
			usedJSHeapSize: 0,
			jsHeapSizeLimit: 0,
		});
	});
});
