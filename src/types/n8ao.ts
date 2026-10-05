import { Pass } from "postprocessing";
import type { Camera, Color, Scene } from "three";

export declare class N8AOPostPass extends Pass {
	constructor(scene: Scene, camera: Camera, width?: number, height?: number);
	camera: Camera;
	scene: Scene;
	configuration: {
		aoSamples: number;
		aoRadius: number;
		aoTones: number;
		denoiseSamples: number;
		denoiseRadius: number;
		distanceFalloff: number;
		intensity: number;
		denoiseIterations: number;
		renderMode: number;
		biasOffset: number;
		biasMultiplier: number;
		color: Color;
		gammaCorrection: boolean;
		depthBufferType: number;
		screenSpaceRadius: boolean;
		halfRes: boolean;
		depthAwareUpsampling: boolean;
		colorMultiply: boolean;
		transparencyAware: boolean;
		accumulate: boolean;
	};
	setQualityMode(mode: "Performance" | "Low" | "Medium" | "High" | "Ultra"): void;
}
