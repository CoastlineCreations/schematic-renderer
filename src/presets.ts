import type { SchematicRendererOptions } from "./SchematicRendererOptions";

/** A quiet, embeddable preview with the same visual settings as Studio. */
export function createPreviewOptions(
	overrides: SchematicRendererOptions = {}
): SchematicRendererOptions {
	return {
		backgroundColor: "#C1D6FF",
		chunkSideLength: 16,
		meshBuildingMode: "batched",
		singleSchematicMode: true,
		enableAdaptiveFPS: true,
		enableAnimatedTextures: false,
		enableAutoOrbit: false,
		enableDragAndDrop: false,
		enableGizmos: false,
		enableInteraction: false,
		enableProgressBar: false,
		maxPixelRatio: 2,
		showAxes: false,
		showGrid: false,
		...overrides,
		cameraOptions: {
			defaultCameraPreset: "perspective",
			enableZoomInOnLoad: false,
			useTightBounds: true,
			...overrides.cameraOptions,
		},
		definitionRegionOptions: { showOnLoad: false, ...overrides.definitionRegionOptions },
		keyboardControlsOptions: { enabled: false, ...overrides.keyboardControlsOptions },
		postProcessingOptions: {
			enabled: true,
			enableGamma: true,
			enableSMAA: true,
			enableSSAO: true,
			...overrides.postProcessingOptions,
		},
		resourcePackOptions: {
			autoRebuild: false,
			enableKeyboardShortcuts: false,
			enableUI: false,
			showMissingPackNotice: false,
			...overrides.resourcePackOptions,
		},
		sidebarOptions: { enabled: false, ...overrides.sidebarOptions },
		wasmMeshBuilderOptions: {
			enabled: true,
			greedyMeshingEnabled: false,
			...overrides.wasmMeshBuilderOptions,
		},
		webgpuOptions: { preferWebGPU: false, ...overrides.webgpuOptions },
	};
}
