import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import * as THREE from "three";
import { CameraWrapper } from "../../CameraWrapper";
import { GizmoManager } from "../../GizmoManager";
import type { SchematicRenderer } from "../../../SchematicRenderer";

function rendererFixture() {
	const canvas = document.createElement("canvas");
	const scene = new THREE.Scene();
	const cameraManager = Object.assign(new EventEmitter(), {
		activeCamera: { camera: new THREE.PerspectiveCamera() },
		controls: new Map(),
	});
	const eventEmitter = new EventEmitter();
	const renderer = {
		canvas,
		sceneManager: { scene },
		cameraManager,
		eventEmitter,
		renderManager: { renderer: { domElement: canvas } },
	} as unknown as SchematicRenderer;
	return { renderer, canvas, scene, eventEmitter };
}

afterEach(() => vi.restoreAllMocks());

describe("camera and transform controls", () => {
	it("leaves creative controls unavailable until the required UI exists", () => {
		const { renderer, canvas } = rendererFixture();
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const camera = new CameraWrapper("perspective", canvas, renderer);
		expect(camera.createControls("creative")).toBeUndefined();
		expect(warning).toHaveBeenCalledOnce();
	});

	it("attaches, displays, and removes the native TransformControls helper", () => {
		const { renderer, scene, eventEmitter } = rendererFixture();
		const manager = new GizmoManager(renderer);
		const helper = scene.children[0];
		expect(helper).toBeInstanceOf(THREE.Object3D);
		const object = new THREE.Group();
		object.name = "region_test";
		scene.add(object);

		// Three.js objects have numeric IDs, unlike selectable wrappers.
		expect(() => eventEmitter.emit("objectSelected", object)).not.toThrow();
		helper.visible = false;
		manager.ensureVisible();
		expect(helper.visible).toBe(true);
		const materials: THREE.Material[] = [];
		helper.traverse((child) => {
			if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
				materials.push(...(Array.isArray(child.material) ? child.material : [child.material]));
			}
		});
		expect(materials.length).toBeGreaterThan(0);
		expect(materials.every((material) => !material.depthTest && !material.depthWrite)).toBe(true);

		manager.dispose();
		expect(scene.children).toEqual([object]);
	});
});
