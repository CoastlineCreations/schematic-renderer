// managers/FlyControls.ts
// First-person fly controls using PointerLockControls for smooth camera movement

import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { EventEmitter } from "events";

export interface FlyControlsOptions {
	/** Movement speed in units per second */
	moveSpeed?: number;
	/** Sprint multiplier when holding shift */
	sprintMultiplier?: number;
	/** Look sensitivity (mouse movement) */
	lookSensitivity?: number;
	/** Keybinds for movement */
	keybinds?: Partial<FlyControlsKeybinds>;
	/** Whether to create the default fly-mode overlay. */
	showOverlay?: boolean;
	/** Also accept arrow keys for horizontal movement. */
	allowArrowKeys?: boolean;
}

export interface FlyControlsKeybinds {
	forward: string;
	backward: string;
	left: string;
	right: string;
	up: string;
	down: string;
	sprint: string;
}

type ControlEvent = { type: "change" | "lock" | "unlock"; target: FlyControls };
type ControlListener = (event: ControlEvent) => void;

const DEFAULT_KEYBINDS: FlyControlsKeybinds = {
	forward: "KeyW",
	backward: "KeyS",
	left: "KeyA",
	right: "KeyD",
	up: "Space",
	down: "KeyC",
	sprint: "ShiftLeft",
};

/**
 * First-person fly controls for navigating 3D scenes.
 * Click to enter fly mode, ESC to exit.
 * WASD to move, Space/C for up/down, Shift to sprint.
 */
export class FlyControls extends EventEmitter {
	private _enabled = true;
	public isLocked: boolean = false;
	private disposed = false;

	private pointerLockControls: PointerLockControls;
	private camera: THREE.Camera;
	private domElement: HTMLElement;

	// Movement state
	private moveSpeed: number;
	private sprintMultiplier: number;
	private keybinds: FlyControlsKeybinds;

	// Input tracking
	private pressedKeys = new Set<string>();
	private velocity = new THREE.Vector3();
	private direction = new THREE.Vector3();
	protected movementScale = new THREE.Vector3(1, 1, 1);
	private forward = new THREE.Vector3();
	private right = new THREE.Vector3();
	private movement = new THREE.Vector3();
	private readonly worldUp = new THREE.Vector3(0, 1, 0);
	private allowArrowKeys: boolean;
	private eventListeners = new Map<ControlEvent["type"], Map<ControlListener, () => void>>();

	// UI elements
	private overlayElement: HTMLDivElement | null = null;

	constructor(camera: THREE.Camera, domElement: HTMLElement, options: FlyControlsOptions = {}) {
		super();
		this.camera = camera;
		this.domElement = domElement;

		// Apply options
		this.moveSpeed = options.moveSpeed ?? 10;
		this.sprintMultiplier = options.sprintMultiplier ?? 2.5;
		this.keybinds = { ...DEFAULT_KEYBINDS, ...options.keybinds };
		this.allowArrowKeys = options.allowArrowKeys ?? false;

		// Create PointerLockControls
		this.pointerLockControls = new PointerLockControls(camera, domElement);
		this.pointerLockControls.pointerSpeed = options.lookSensitivity ?? 1;

		// Set up event listeners
		this.setupEventListeners();

		// Create overlay UI
		if (options.showOverlay !== false) this.createOverlay();
	}

	public get enabled(): boolean {
		return this._enabled;
	}

	public set enabled(enabled: boolean) {
		this._enabled = enabled && !this.disposed;
		this.pointerLockControls.enabled = this._enabled;
		if (!this._enabled) {
			this.pressedKeys.clear();
			this.velocity.set(0, 0, 0);
			if (this.isLocked) this.unlock();
			this.setOverlayVisible(false);
		}
	}

	public get object(): THREE.Camera {
		return this.camera;
	}

	public set object(camera: THREE.Camera) {
		this.camera = camera;
		this.pointerLockControls.object = camera;
	}

	/** Three.js-style events remain available alongside EventEmitter's on/off API. */
	public addEventListener(type: ControlEvent["type"], listener: ControlListener): void {
		let listeners = this.eventListeners.get(type);
		if (!listeners) this.eventListeners.set(type, (listeners = new Map()));
		if (listeners.has(listener)) return;
		const callback = () => listener.call(this, { type, target: this });
		listeners.set(listener, callback);
		this.on(type, callback);
	}

	public removeEventListener(type: ControlEvent["type"], listener: ControlListener): void {
		const listeners = this.eventListeners.get(type);
		const callback = listeners?.get(listener);
		if (callback) this.off(type, callback);
		listeners?.delete(listener);
	}

	private setupEventListeners(): void {
		this.pointerLockControls.addEventListener("change", this.onPointerChange);
		// Pointer lock events
		this.pointerLockControls.addEventListener("lock", () => {
			if (!this.enabled) return;
			this.isLocked = true;
			this.showOverlay(false);
			this.emit("lock");
		});

		this.pointerLockControls.addEventListener("unlock", () => {
			this.isLocked = false;
			this.pressedKeys.clear();
			this.velocity.set(0, 0, 0);
			// Only show overlay if fly controls are enabled
			if (this.enabled) {
				this.showOverlay(true);
			}
			this.emit("unlock");
		});

		// Click to lock
		this.domElement.addEventListener("click", this.onCanvasClick);

		// Keyboard events
		document.addEventListener("keydown", this.onKeyDown);
		document.addEventListener("keyup", this.onKeyUp);
		window.addEventListener("blur", this.onBlur);
	}

	private onPointerChange = (): void => {
		if (this.enabled) this.emit("change");
	};

	private onBlur = (): void => {
		this.pressedKeys.clear();
	};

	private movementKey(code: string): string {
		if (!this.allowArrowKeys) return code;
		switch (code) {
			case "ArrowUp":
				return this.keybinds.forward;
			case "ArrowDown":
				return this.keybinds.backward;
			case "ArrowLeft":
				return this.keybinds.left;
			case "ArrowRight":
				return this.keybinds.right;
			default:
				return code;
		}
	}

	private onCanvasClick = (): void => {
		if (this.enabled && !this.isLocked) {
			this.lock();
		}
	};

	private onKeyDown = (event: KeyboardEvent): void => {
		if (!this.enabled || !this.isLocked) return;

		const key = this.movementKey(event.code);
		this.pressedKeys.add(key);

		// Prevent default for movement keys
		if (Object.values(this.keybinds).includes(key)) {
			event.preventDefault();
			this.emit("change");
		}
	};

	private onKeyUp = (event: KeyboardEvent): void => {
		this.pressedKeys.delete(this.movementKey(event.code));
	};

	private onOverlayClick = (): void => {
		if (this.enabled && !this.isLocked) {
			this.lock();
		}
	};

	private createOverlay(): void {
		this.overlayElement = document.createElement("div");
		Object.assign(this.overlayElement.style, {
			position: "absolute",
			top: "0",
			left: "0",
			width: "100%",
			height: "100%",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			backgroundColor: "rgba(0, 0, 0, 0.5)",
			color: "white",
			fontFamily: "system-ui, -apple-system, sans-serif",
			fontSize: "18px",
			textAlign: "center",
			cursor: "pointer",
			zIndex: "900", // Lower than sidebar (1000) so UI panels appear above
			pointerEvents: "auto",
			opacity: "0",
			transition: "opacity 0.2s ease",
		});

		const content = document.createElement("div");
		content.innerHTML = `
			<div style="font-size: 24px; margin-bottom: 12px;">Click to Enter Fly Mode</div>
			<div style="font-size: 14px; color: rgba(255,255,255,0.7);">
				<div>WASD - Move</div>
				<div>Space - Up • C - Down</div>
				<div>Shift - Sprint</div>
				<div>ESC - Exit</div>
			</div>
		`;
		this.overlayElement.appendChild(content);

		// Add click listener to overlay
		this.overlayElement.addEventListener("click", this.onOverlayClick);

		// Position relative to canvas
		const parent = this.domElement.parentElement;
		if (parent) {
			parent.style.position = "relative";
			parent.appendChild(this.overlayElement);
		}

		// Initially hidden
		this.showOverlay(false);
	}

	private showOverlay(visible: boolean): void {
		if (this.overlayElement) {
			this.overlayElement.style.opacity = visible ? "1" : "0";
			this.overlayElement.style.pointerEvents = visible ? "auto" : "none";
		}
	}

	/**
	 * Show or hide the fly controls overlay
	 * @param visible Whether the overlay should be visible
	 */
	public setOverlayVisible(visible: boolean): void {
		this.showOverlay(visible);
	}

	/**
	 * Lock the pointer and enter fly mode
	 */
	public lock(): void {
		if (this.enabled) {
			this.pointerLockControls.lock();
		}
	}

	/**
	 * Unlock the pointer and exit fly mode
	 */
	public unlock(): void {
		this.pointerLockControls.unlock();
	}

	/**
	 * Toggle pointer lock
	 */
	public toggle(): void {
		if (this.isLocked) {
			this.unlock();
		} else {
			this.lock();
		}
	}

	/**
	 * Update movement - call this every frame
	 */
	public update(deltaTime: number = 0): void {
		if (!this.enabled || !this.isLocked) return;

		// Calculate movement direction
		this.direction.set(0, 0, 0);

		// Forward/Backward
		if (this.pressedKeys.has(this.keybinds.forward)) {
			this.direction.z -= 1;
		}
		if (this.pressedKeys.has(this.keybinds.backward)) {
			this.direction.z += 1;
		}

		// Left/Right (strafe)
		if (this.pressedKeys.has(this.keybinds.left)) {
			this.direction.x -= 1;
		}
		if (this.pressedKeys.has(this.keybinds.right)) {
			this.direction.x += 1;
		}

		// Up/Down (world space)
		if (this.pressedKeys.has(this.keybinds.up)) {
			this.direction.y += 1;
		}
		if (this.pressedKeys.has(this.keybinds.down)) {
			this.direction.y -= 1;
		}

		// Normalize direction to prevent faster diagonal movement
		if (this.direction.length() > 0) {
			this.direction.normalize();
		}

		// Apply sprint multiplier
		let speed = this.moveSpeed;
		if (this.pressedKeys.has(this.keybinds.sprint)) {
			speed *= this.sprintMultiplier;
		}

		// Calculate velocity
		this.velocity
			.copy(this.direction)
			.multiply(this.movementScale)
			.multiplyScalar(speed * Math.min(deltaTime, 0.1));

		// Get camera direction vectors
		this.camera.getWorldDirection(this.forward);
		this.forward.y = 0;
		this.forward.normalize();
		this.right.crossVectors(this.worldUp, this.forward).normalize();

		// Apply movement in camera space
		this.movement.set(0, 0, 0);
		this.movement.addScaledVector(this.forward, -this.velocity.z);
		this.movement.addScaledVector(this.right, -this.velocity.x);
		this.movement.y += this.velocity.y;

		// Update camera position
		this.camera.position.add(this.movement);

		// Emit change event
		if (this.movement.lengthSq() > 0) {
			this.emit("change");
		}
	}

	// Getters/Setters for settings

	public getMoveSpeed(): number {
		return this.moveSpeed;
	}

	public setMoveSpeed(speed: number): void {
		this.moveSpeed = speed;
	}

	public getSprintMultiplier(): number {
		return this.sprintMultiplier;
	}

	public setSprintMultiplier(multiplier: number): void {
		this.sprintMultiplier = multiplier;
	}

	public getKeybinds(): FlyControlsKeybinds {
		return { ...this.keybinds };
	}

	public setKeybinds(keybinds: Partial<FlyControlsKeybinds>): void {
		this.keybinds = { ...this.keybinds, ...keybinds };
	}

	/**
	 * Get the underlying PointerLockControls for advanced usage
	 */
	public getPointerLockControls(): PointerLockControls {
		return this.pointerLockControls;
	}

	/**
	 * Clean up resources
	 */
	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.enabled = false;
		// Remove event listeners
		this.domElement.removeEventListener("click", this.onCanvasClick);
		document.removeEventListener("keydown", this.onKeyDown);
		document.removeEventListener("keyup", this.onKeyUp);
		window.removeEventListener("blur", this.onBlur);
		this.pointerLockControls.removeEventListener("change", this.onPointerChange);

		// Unlock if locked
		if (this.isLocked) {
			this.unlock();
		}

		// Remove overlay and its click listener
		if (this.overlayElement) {
			this.overlayElement.removeEventListener("click", this.onOverlayClick);
			if (this.overlayElement.parentElement) {
				this.overlayElement.parentElement.removeChild(this.overlayElement);
			}
		}
		this.overlayElement = null;

		// Dispose PointerLockControls
		this.pointerLockControls.dispose();

		// Clear state
		this.pressedKeys.clear();
		this.eventListeners.clear();
		this.removeAllListeners();
	}
}
