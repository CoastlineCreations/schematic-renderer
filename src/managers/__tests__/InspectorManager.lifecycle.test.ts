import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { InspectorManager } from "../InspectorManager";
import type { SchematicRenderer } from "../../SchematicRenderer";

function rendererFixture() {
	const canvas = document.createElement("canvas");
	const parent = document.createElement("div");
	parent.append(canvas);
	document.body.append(parent);
	return {
		canvas,
		options: {},
		sceneManager: { scene: new THREE.Scene() },
		cameraManager: { activeCamera: { camera: new THREE.PerspectiveCamera() } },
		getFPS: vi.fn(() => 60),
	} as unknown as SchematicRenderer;
}

afterEach(() => {
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("inspector lifecycle", () => {
	it("cancels stats timers, removes shortcuts and destroys the GUI once", async () => {
		const renderer = rendererFixture();
		const inspector = new InspectorManager(renderer);
		await inspector.ready;
		const gui = inspector.getGUI();
		expect(gui).not.toBeNull();
		if (!gui) throw new Error("Inspector GUI missing");
		const destroy = vi.spyOn(gui, "destroy");
		const clearInterval = vi.spyOn(globalThis, "clearInterval");
		const toggle = vi.spyOn(inspector, "toggle");
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "`" }));
		expect(toggle).toHaveBeenCalledOnce();
		inspector.dispose();
		inspector.dispose();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "`" }));
		expect(toggle).toHaveBeenCalledOnce();
		expect(clearInterval).toHaveBeenCalledTimes(3);
		expect(destroy).toHaveBeenCalledOnce();
		expect(inspector.getGUI()).toBeNull();
		expect(gui.domElement.isConnected).toBe(false);
	});

	it("cannot attach GUI, timers or shortcuts after disposal during lazy loading", async () => {
		const setInterval = vi.spyOn(globalThis, "setInterval");
		const inspector = new InspectorManager(rendererFixture());
		const toggle = vi.spyOn(inspector, "toggle");
		inspector.dispose();
		await inspector.ready;
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "~" }));
		expect(setInterval).not.toHaveBeenCalled();
		expect(toggle).not.toHaveBeenCalled();
		expect(inspector.getGUI()).toBeNull();
		expect(document.querySelector(".lil-gui")).toBeNull();
	});
});
