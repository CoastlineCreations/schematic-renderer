import { describe, expect, it, vi } from "vitest";
import { PerspectiveCamera } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DiffViewer } from "./DiffViewer";

const fixture = vi.hoisted(() => ({
	controls: undefined as unknown,
	initialize: () => {},
}));

vi.mock("../SchematicRenderer", () => ({
	SchematicRenderer: class {
		cameraManager = { activeControls: fixture.controls };
		dispose = vi.fn();
		constructor(
			_canvas: HTMLCanvasElement,
			_data: object,
			_packs: object,
			options: { callbacks: { onRendererInitialized(): void } }
		) {
			fixture.initialize = options.callbacks.onRendererInitialized;
		}
	},
}));

describe("DiffViewer camera initialization", () => {
	it.each([true, false])(
		"uses autoRotate=%s on the active control and stops on interaction",
		(autoRotate) => {
			const canvas = document.createElement("canvas");
			const controls = new OrbitControls(new PerspectiveCamera(), canvas);
			fixture.controls = controls;
			const viewer = new DiffViewer(canvas, { autoRotate });
			fixture.initialize();
			expect(controls.autoRotate).toBe(autoRotate);
			controls.dispatchEvent({ type: "start" });
			expect(controls.autoRotate).toBe(false);
			viewer.dispose();
			controls.dispose();
		}
	);
	it("starts rotation on the active orbit control and stops it when interaction begins", () => {
		const canvas = document.createElement("canvas");
		const controls = new OrbitControls(new PerspectiveCamera(), canvas);
		fixture.controls = controls;
		const viewer = new DiffViewer(canvas);
		fixture.initialize();
		expect(controls.autoRotate).toBe(true);
		expect(controls.autoRotateSpeed).toBe(1);
		controls.dispatchEvent({ type: "start" });
		expect(controls.autoRotate).toBe(false);
		viewer.dispose();
		controls.dispose();
	});
});
