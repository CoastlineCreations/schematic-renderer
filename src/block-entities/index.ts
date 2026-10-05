import { createCustomPlayerHeadOverlay } from "./custom-player-heads";
import type { PlayerHeadOptions } from "./custom-player-heads";
import { createBannerOverlay, resolveBannerBlockState } from "./banners";
import { createCopperChestOverlay, resolveCopperChestStage } from "./copper-chests";
import { createDecoratedPotOverlay } from "./decorated-pots";
import { createShulkerBoxOverlay, resolveShulkerBoxVariant } from "./shulker-boxes";
import { captureBlockEntitySnapshot, filterBlockEntitySnapshot } from "./types";
import type { BlockEntityResources, BlockEntitySchematic, BlockEntitySnapshot } from "./types";

export * from "./types";
export * from "./custom-player-heads";
export * from "./decorated-pots";
export * from "./copper-chests";
export * from "./shulker-boxes";
export * from "./banners";

export interface BlockEntityOverlay {
	readonly count: number;
	dispose(): void;
}

export interface BlockEntityRenderContext {
	readonly schematic: BlockEntitySchematic;
	readonly signal: AbortSignal;
	readonly snapshot: BlockEntitySnapshot;
	readonly resources: BlockEntityResources;
	readonly options: BlockEntityOptions;
}

/** Renderers own their created geometry/materials; resource-pack assets are borrowed. */
export interface BlockEntityRenderer {
	/** Stable ID; a consumer renderer with the same ID replaces the default. */
	readonly id: string;
	/** These blocks are delegated by the chunk mesher to this renderer. */
	supportsBlock(blockName: string): boolean;
	/** Observe signal and return an idempotent disposer for all created resources. */
	render(context: BlockEntityRenderContext): Promise<BlockEntityOverlay>;
}

export interface BlockEntityOptions {
	/** Defaults to true. Disabled restores ordinary Cubane block rendering. */
	enabled?: boolean;
	/** Defaults to true. Set false for an entirely custom registry. */
	includeDefaultRenderers?: boolean;
	/** Additional renderers, or replacements for a built-in ID. */
	renderers?: readonly BlockEntityRenderer[];
	playerHeads?: PlayerHeadOptions;
	/** Optional diagnostic hook. Rendering failures are isolated per renderer. */
	onError?: (rendererId: string, error: unknown) => void;
}

export const DEFAULT_BLOCK_ENTITY_RENDERERS: readonly BlockEntityRenderer[] = [
	{
		id: "minecraft:player_head",
		supportsBlock: (name) =>
			name === "minecraft:player_head" || name === "minecraft:player_wall_head",
		render: ({ schematic, signal, snapshot, resources, options }) =>
			createCustomPlayerHeadOverlay(schematic, signal, snapshot, resources, options.playerHeads),
	},
	{
		id: "minecraft:decorated_pot",
		supportsBlock: (name) => name === "minecraft:decorated_pot",
		render: ({ schematic, signal, snapshot, resources }) =>
			createDecoratedPotOverlay(schematic, signal, snapshot, resources),
	},
	{
		id: "minecraft:copper_chest",
		supportsBlock: (name) => resolveCopperChestStage(name) !== null,
		render: ({ schematic, signal, snapshot, resources }) =>
			createCopperChestOverlay(schematic, signal, snapshot, resources),
	},
	{
		id: "minecraft:shulker_box",
		supportsBlock: (name) => resolveShulkerBoxVariant(name) !== null,
		render: ({ schematic, signal, snapshot, resources }) =>
			createShulkerBoxOverlay(schematic, signal, snapshot, resources),
	},
	{
		id: "minecraft:banner",
		supportsBlock: (name) => resolveBannerBlockState({ name, properties: {} }) !== null,
		render: ({ schematic, signal, snapshot, resources }) =>
			createBannerOverlay(schematic, signal, snapshot, resources),
	},
];

/** Build once per load/build, then reuse for palette delegation and rendering. */
export class BlockEntityRendererRegistry {
	private readonly renderers = new Map<string, BlockEntityRenderer>();

	constructor(options: BlockEntityOptions = {}) {
		if (options.enabled === false) return;
		if (options.includeDefaultRenderers !== false) {
			for (const renderer of DEFAULT_BLOCK_ENTITY_RENDERERS) this.register(renderer);
		}
		for (const renderer of options.renderers ?? []) this.register(renderer);
	}

	register(renderer: BlockEntityRenderer): this {
		this.renderers.set(renderer.id, renderer);
		return this;
	}

	unregister(id: string): boolean {
		return this.renderers.delete(id);
	}

	handles(blockName: string): boolean {
		for (const renderer of this.renderers.values()) {
			if (renderer.supportsBlock(blockName)) return true;
		}
		return false;
	}

	values(): IterableIterator<BlockEntityRenderer> {
		return this.renderers.values();
	}
}

export function isBlockEntityHandled(blockName: string, options: BlockEntityOptions = {}): boolean {
	return new BlockEntityRendererRegistry(options).handles(blockName);
}

/**
 * Render all registered block entities under the schematic transform. Abort
 * disposes completed overlays immediately; late async completions are disposed
 * before publication. Call dispose when replacing/removing the schematic.
 */
export async function renderBlockEntities(
	schematic: BlockEntitySchematic,
	signal: AbortSignal,
	resources: BlockEntityResources,
	options: BlockEntityOptions = {}
): Promise<BlockEntityOverlay> {
	if (signal.aborted || options.enabled === false) return { count: 0, dispose() {} };
	const snapshot = filterBlockEntitySnapshot(
		captureBlockEntitySnapshot(schematic.schematicWrapper),
		schematic.renderingBounds
	);
	const registry = new BlockEntityRendererRegistry(options);
	const overlays: BlockEntityOverlay[] = [];
	const reportError = (rendererId: string, error: unknown) => {
		try {
			if (options.onError !== undefined) options.onError(rendererId, error);
			else console.warn(`[schematic-renderer] Block-entity renderer ${rendererId} failed.`, error);
		} catch {
			// Diagnostic hooks cannot interrupt resource cleanup or other renderers.
		}
	};
	const disposeOverlay = (overlay: BlockEntityOverlay) => {
		try {
			overlay.dispose();
		} catch (error) {
			reportError("dispose", error);
		}
	};
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		signal.removeEventListener("abort", dispose);
		for (let index = overlays.length - 1; index >= 0; index--) disposeOverlay(overlays[index]);
	};
	signal.addEventListener("abort", dispose, { once: true });
	await Promise.all(
		[...registry.values()].map(
			(renderer) =>
				new Promise<void>((resolve) => {
					const aborted = () => resolve();
					signal.addEventListener("abort", aborted, { once: true });
					if (signal.aborted) {
						signal.removeEventListener("abort", aborted);
						resolve();
						return;
					}
					Promise.resolve()
						.then(() =>
							signal.aborted
								? { count: 0, dispose() {} }
								: renderer.render({ schematic, signal, snapshot, resources, options })
						)
						.then(
							(overlay) => {
								if (disposed || signal.aborted) disposeOverlay(overlay);
								else overlays.push(overlay);
							},
							(error: unknown) => {
								if (!signal.aborted) reportError(renderer.id, error);
							}
						)
						.finally(() => {
							signal.removeEventListener("abort", aborted);
							resolve();
						});
				})
		)
	);
	return {
		count: disposed ? 0 : overlays.reduce((count, overlay) => count + overlay.count, 0),
		dispose,
	};
}
