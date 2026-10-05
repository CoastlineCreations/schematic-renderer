/** n8ao ships JavaScript only; keep its implementation constructor typed locally. */
declare module "n8ao" {
	export const N8AOPostPass: new (
		scene: import("three").Scene,
		camera: import("three").Camera,
		width?: number,
		height?: number
	) => import("./n8ao").N8AOPostPass;
}
