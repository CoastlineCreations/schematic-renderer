import { Vector3, type Camera } from "three";
import { FlyControls } from "./FlyControls";

/** Legacy creative preset, backed by the renderer's current Three.js controls. */
export class CreativeControls extends FlyControls {
	public movementSpeed = new Vector3(200, 200, 200);

	constructor(
		camera: Camera,
		domElement: HTMLElement,
		private menu: HTMLElement,
		private blocker: HTMLElement
	) {
		super(camera, domElement, {
			moveSpeed: 20,
			sprintMultiplier: 1,
			keybinds: { down: "ShiftLeft" },
			allowArrowKeys: true,
			showOverlay: false,
		});
		this.blocker.addEventListener("click", this.enter);
		this.on("lock", () => this.setOverlayVisible(false));
		this.on("unlock", () => this.setOverlayVisible(this.enabled));
	}

	private readonly enter = (): void => this.lock();

	public override update(deltaTime = 0): void {
		this.movementScale.copy(this.movementSpeed).divideScalar(200);
		super.update(deltaTime);
	}

	public override setOverlayVisible(visible: boolean): void {
		this.blocker.style.display = visible ? "block" : "none";
		this.menu.style.display = visible ? "block" : "none";
	}

	public getObject(): Camera {
		return this.object;
	}

	public moveForward(distance: number): void {
		this.getPointerLockControls().moveForward(distance);
	}

	public moveRight(distance: number): void {
		this.getPointerLockControls().moveRight(distance);
	}

	public override dispose(): void {
		this.blocker.removeEventListener("click", this.enter);
		super.dispose();
		this.blocker.remove();
	}
}
