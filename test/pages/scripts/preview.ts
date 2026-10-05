import { SchematicRenderer, SchematicRendererContext, createPreviewOptions } from "../../../src";

const canvas = document.querySelector<HTMLCanvasElement>("#preview")!;
const viewport = document.querySelector<HTMLDivElement>("#viewport")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const input = document.querySelector<HTMLInputElement>("#file")!;
const capture = document.querySelector<HTMLButtonElement>("#capture")!;
const sample = document.querySelector<HTMLButtonElement>("#sample")!;
const reopen = document.querySelector<HTMLButtonElement>("#reopen")!;
let renderer: SchematicRenderer | null = null;
let context: SchematicRendererContext | null = null;
let currentData: ArrayBuffer | null = null;
let currentName = "Rendering sample";
let busy = false;

function setBusy(value: boolean) {
	busy = value;
	input.disabled = value;
	capture.disabled = value;
	sample.disabled = value;
	reopen.disabled = value;
}

async function load(data: ArrayBuffer, name: string) {
	if (!renderer?.schematicManager) throw new Error("Preview is not ready");
	status.textContent = `Loading ${name}…`;
	await renderer.schematicManager.loadSchematic("preview", data, { focused: false });
	await renderer.schematicManager.getSchematic("preview")?.getMeshes();
	await renderer.cameraManager.focusOnSchematics({
		animationDuration: 0,
		padding: 0.1,
		useTightBounds: true,
	});
	renderer.invalidate();
	currentData = data;
	currentName = name;
	status.textContent = name;
	document.documentElement.dataset.previewReady = "true";
}

async function createRenderer() {
	if (!context) throw new Error("Minecraft resources are not ready");
	renderer?.dispose();
	const activeContext = context;
	await new Promise<void>((resolve, reject) => {
		const timeout = window.setTimeout(
			() => reject(new Error("Preview initialization timed out")),
			30_000
		);
		renderer = new SchematicRenderer(
			canvas,
			{},
			{},
			createPreviewOptions({
				context: activeContext,
				blockEntityOptions: { playerHeads: { defaultTextureUrl: "/minecraft-default-player.png" } },
				callbacks: {
					onRendererInitialized() {
						window.clearTimeout(timeout);
						resolve();
					},
				},
			})
		);
	});
}

async function run(action: () => Promise<void>) {
	if (busy) return;
	setBusy(true);
	try {
		await action();
	} catch (error) {
		status.textContent = error instanceof Error ? error.message : "Preview could not be loaded";
		console.error(error);
	} finally {
		setBusy(false);
	}
}

async function loadSample() {
	const response = await fetch("/schematics/rendering-features.schem");
	if (!response.ok) throw new Error("Sample could not be loaded");
	await load(await response.arrayBuffer(), "Rendering sample");
}

input.addEventListener("change", () => {
	const file = input.files?.[0];
	if (file) void run(async () => load(await file.arrayBuffer(), file.name));
});
sample.addEventListener("click", () => void run(loadSample));
reopen.addEventListener(
	"click",
	() =>
		void run(async () => {
			await createRenderer();
			if (currentData) await load(currentData, currentName);
		})
);
capture.addEventListener(
	"click",
	() =>
		void run(async () => {
			if (!renderer) return;
			const blob = await renderer.takeScreenshot({
				format: "image/webp",
				width: 1280,
				height: 720,
				quality: 0.88,
				transparent: false,
			});
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = "schematic-preview.webp";
			link.click();
			window.setTimeout(() => URL.revokeObjectURL(url), 1000);
		})
);
const observer = new ResizeObserver(() => renderer?.renderManager?.updateCanvasSize());
observer.observe(viewport);
const cleanup = () => {
	observer.disconnect();
	renderer?.dispose();
	context?.dispose();
	renderer = null;
	context = null;
};
window.addEventListener("pagehide", cleanup, { once: true });
if (import.meta.hot) import.meta.hot.dispose(cleanup);

void run(async () => {
	context = await SchematicRendererContext.create(
		{
			vanilla: async () => {
				const response = await fetch("/minecraft-26.2-resources.zip?v=f1424b92");
				if (!response.ok) throw new Error("Minecraft resources could not be loaded");
				return response.blob();
			},
		},
		{ resourcePackOptions: createPreviewOptions().resourcePackOptions }
	);
	await createRenderer();
	await loadSample();
});
