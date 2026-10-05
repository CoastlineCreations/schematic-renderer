import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { EventEmitter } from "events";
import { CameraWrapper } from "../CameraWrapper";
import { CameraManager } from "../CameraManager";
import { CreativeControls } from "../CreativeControls";
import { FlyControls } from "../FlyControls";
import type { SchematicRenderer } from "../../SchematicRenderer";

function fixture() {
	const camera = new THREE.PerspectiveCamera();
	const canvas = document.createElement("canvas");
	const menu = document.createElement("div");
	const blocker = document.createElement("div");
	blocker.append(menu);
	document.body.append(canvas, blocker);
	const controls = new CreativeControls(camera, canvas, menu, blocker);
	const pointer = controls.getPointerLockControls();
	return { controls, camera, canvas, menu, blocker, pointer };
}

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("creative controls", () => {
	it("preserves the creative preset, pointer overlay and legacy movement keys", () => {
		const { controls, camera, pointer, blocker, menu } = fixture();
		const lock = vi.spyOn(pointer, "lock").mockImplementation(() => {});
		menu.click();
		expect(lock).toHaveBeenCalledOnce();
		pointer.dispatchEvent({ type: "lock" });
		expect(blocker.style.display).toBe("none");
		document.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowUp" }));
		controls.update(0.05);
		expect(camera.position.z).toBeCloseTo(-1);
		document.dispatchEvent(new KeyboardEvent("keyup", { code: "ArrowUp" }));
		document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
		controls.update(0.05);
		expect(camera.position.y).toBeCloseTo(1);
		document.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
		document.dispatchEvent(new KeyboardEvent("keydown", { code: "ShiftLeft" }));
		controls.update(0.05);
		expect(camera.position.y).toBeCloseTo(0);
		pointer.dispatchEvent({ type: "unlock" });
		expect(blocker.style.display).toBe("block");
		controls.dispose();
	});

	it("invalidates on mouse changes and cannot move or lock after disposal", () => {
		const { controls, camera, pointer, menu } = fixture();
		const change = vi.fn();
		controls.addEventListener("change", change);
		pointer.dispatchEvent({ type: "change" });
		expect(change).toHaveBeenCalledOnce();
		const lock = vi.spyOn(pointer, "lock").mockImplementation(() => {});
		controls.dispose();
		controls.dispose();
		menu.click();
		controls.lock();
		document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
		controls.update(0.05);
		pointer.dispatchEvent({ type: "change" });
		expect(lock).not.toHaveBeenCalled();
		expect(change).toHaveBeenCalledOnce();
		expect(camera.position.length()).toBe(0);
	});

	it("creates creative and fly controls without a second Three.js copy", () => {
		const canvas = document.createElement("canvas");
		const renderer = {
			uiManager: {
				createFPVElements: () => ({
					menu: document.createElement("div"),
					blocker: document.createElement("div"),
				}),
			},
		} as unknown as SchematicRenderer;
		const camera = new CameraWrapper("perspective", canvas, renderer);
		const creative = camera.createControls("creative");
		const fly = camera.createControls("fly");
		expect(creative).toBeInstanceOf(CreativeControls);
		expect(fly).toBeInstanceOf(FlyControls);
		expect(creative?.object).toBe(camera.camera);
		creative?.dispose();
		fly?.dispose();
	});

	it("starts in the creative preset and safely switches back to orbit controls", () => {
		const canvas = document.createElement("canvas");
		const blocker = document.createElement("div");
		const menu = document.createElement("div");
		const renderer = {
			canvas,
			options: {},
			eventEmitter: new EventEmitter(),
			invalidate: vi.fn(),
			uiManager: {
				createFPVElements: () => ({ menu, blocker }),
				hideFPVOverlay: vi.fn(),
				showFPVOverlay: vi.fn(),
			},
		} as unknown as SchematicRenderer;
		const manager = new CameraManager(renderer, { defaultCameraPreset: "perspective_fpv" });
		const controls = manager.activeControls;
		expect(controls).toBeInstanceOf(CreativeControls);
		expect(controls?.enabled).toBe(true);
		expect(blocker.style.display).toBe("block");
		manager.switchCameraPreset("perspective");
		expect(controls?.enabled).toBe(false);
		expect(blocker.style.display).toBe("none");
		expect(manager.activeControls?.enabled).toBe(true);
		manager.dispose();
	});
});
