import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { entityModelLoaders, type EntityModelLoader } from "./entity-models";

export class EntityRenderer {
	private debug: boolean = false;
	private loader = new GLTFLoader();
	private modelCache = new Map<string, THREE.Object3D>();
	private pendingModels = new Map<string, Promise<THREE.Object3D | null>>();
	private disposed = false;

	constructor(
		private readonly modelLoaders: Readonly<Record<string, EntityModelLoader>> = entityModelLoaders
	) {}

	/** Load only the requested model and return an independent scene hierarchy. */
	public async createEntityMesh(entityName: string): Promise<THREE.Object3D | null> {
		if (this.disposed) return null;

		const cached = this.modelCache.get(entityName);
		if (cached) {
			if (this.debug) console.log(`Using cached model for ${entityName}`);
			return clone(cached);
		}

		if (!Object.prototype.hasOwnProperty.call(this.modelLoaders, entityName)) {
			console.warn(`Model for entity "${entityName}" not found`);
			return null;
		}

		let pending = this.pendingModels.get(entityName);
		if (!pending) {
			pending = this.loadModel(entityName, this.modelLoaders[entityName])
				.catch((error: unknown) => {
					if (!this.disposed)
						console.error(`Failed to create mesh for entity ${entityName}:`, error);
					return null;
				})
				.finally(() => this.pendingModels.delete(entityName));
			this.pendingModels.set(entityName, pending);
		}

		const model = await pending;
		return model && !this.disposed ? clone(model) : null;
	}

	private async loadModel(
		entityName: string,
		load: EntityModelLoader
	): Promise<THREE.Object3D | null> {
		const { default: base64Data } = await load();
		if (this.disposed) return null;

		const binaryString = atob(base64Data);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);

		const { scene: model } = await this.loader.parseAsync(bytes.buffer, "");
		if (this.disposed) {
			this.disposeModels([model]);
			return null;
		}

		model.traverse((child) => {
			if (!(child instanceof THREE.Mesh)) return;
			const materials = Array.isArray(child.material) ? child.material : [child.material];
			for (const material of materials) {
				if (!(material instanceof THREE.MeshStandardMaterial)) continue;
				// Preserve the renderer's existing gamma correction for entity textures.
				if (material.map) material.map.colorSpace = THREE.LinearSRGBColorSpace;
				if (material.emissiveMap) material.emissiveMap.colorSpace = THREE.LinearSRGBColorSpace;
				material.needsUpdate = true;
			}
		});

		const group = new THREE.Group();
		model.position.set(0, -0.5, 0);
		group.add(model);
		this.modelCache.set(entityName, group);
		return group;
	}

	/** Preload a selection using the same deduplicated requests as normal rendering. */
	public async preloadModels(entityNames: string[]): Promise<void> {
		await Promise.all(entityNames.map((name) => this.createEntityMesh(name)));
		if (this.debug) console.log(`Preloaded ${entityNames.length} models`);
	}

	public setDebug(debug: boolean): void {
		this.debug = debug;
	}

	/** Dispose after all rendered clones have been removed; their GPU resources are shared. */
	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.disposeModels(this.modelCache.values());
		this.modelCache.clear();
		this.pendingModels.clear();
	}

	private disposeModels(models: Iterable<THREE.Object3D>): void {
		const resources = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();
		for (const model of models) {
			model.traverse((child) => {
				if (!(child instanceof THREE.Mesh)) return;
				resources.add(child.geometry);
				const materials = Array.isArray(child.material) ? child.material : [child.material];
				for (const material of materials) {
					resources.add(material);
					for (const value of Object.values(material)) {
						if (value instanceof THREE.Texture) resources.add(value);
					}
				}
			});
		}
		for (const resource of resources) resource.dispose();
	}
}
