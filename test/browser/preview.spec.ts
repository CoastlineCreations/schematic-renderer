import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SchematicRenderer } from "../../src/SchematicRenderer";

test("renders all five entity families, reopens, accepts a local file and exports a populated image", async ({
	page,
}, testInfo) => {
	const distribution = testInfo.project.name;
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	if (distribution !== "source") {
		const asset = (file: string) => `/@fs${path.resolve(file)}`;
		if (distribution === "umd") {
			// Serve the actual classic-script artifact without Vite's ES module rewriting.
			await page.route("**/dist/schematic-renderer.umd.js", async (route) => {
				await route.fulfill({
					contentType: "text/javascript",
					body: await readFile("dist/schematic-renderer.umd.js"),
				});
			});
		}
		await page.route("**/src/index.ts*", async (route) => {
			const body =
				distribution === "es"
					? `export * from ${JSON.stringify(asset("dist/schematic-renderer.es.js"))};`
					: `import * as THREE from ${JSON.stringify(asset("node_modules/three/build/three.module.js"))};
				   import * as Nucleation from ${JSON.stringify(asset("node_modules/nucleation/index.mjs"))};
				   globalThis.THREE = THREE; globalThis.Nucleation = Nucleation;
				   await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = ${JSON.stringify(asset("dist/schematic-renderer.umd.js"))}; script.onload = resolve; script.onerror = reject; document.head.append(script); });
				   export const { SchematicRenderer, SchematicRendererContext, createPreviewOptions } = globalThis.SchematicRenderer;`;
			await route.fulfill({ contentType: "text/javascript", body });
		});
	}
	await page.goto("/preview.html");
	await expect(page.locator("#status")).toHaveText("Rendering sample", { timeout: 45_000 });
	await expect(page.locator("#capture")).toBeEnabled();

	const entityGroups = async () =>
		page.evaluate(() => {
			const canvas = document.querySelector("#preview") as HTMLCanvasElement & {
				schematicRenderer?: SchematicRenderer;
			};
			const schematic = canvas.schematicRenderer?.schematicManager?.getSchematic("preview");
			return schematic?.group.children
				.filter((child) => child.name.startsWith("schematic-renderer:"))
				.map((child) => child.name)
				.sort();
		});
	const expectedGroups = [
		"banners",
		"copper-chests",
		"custom-player-heads",
		"decorated-pots",
		"shulker-boxes",
	]
		.map((name) => `schematic-renderer:${name}`)
		.sort();
	expect(await entityGroups()).toEqual(expectedGroups);
	await page.evaluate(async () => {
		const canvas = document.querySelector("#preview") as HTMLCanvasElement & {
			schematicRenderer?: SchematicRenderer;
		};
		const schematic = canvas.schematicRenderer?.schematicManager?.getSchematic("preview");
		if (!schematic) throw new Error("Preview schematic missing");
		await Promise.all(Array.from({ length: 8 }, () => schematic.rebuildMesh()));
	});
	expect(await entityGroups()).toEqual(expectedGroups);
	for (let attempt = 0; attempt < 3; attempt++) {
		await page.locator("#reopen").click();
		await expect(page.locator("#reopen")).toBeEnabled({ timeout: 30_000 });
		expect(await entityGroups()).toEqual(expectedGroups);
	}
	await page
		.locator("#file")
		.setInputFiles(path.resolve("test/public/schematics/rendering-features.schem"));
	await expect(page.locator("#status")).toHaveText("rendering-features.schem");
	await expect(page.locator("#capture")).toBeEnabled();
	expect(await entityGroups()).toEqual(expectedGroups);
	const downloadPromise = page.waitForEvent("download");
	await page.locator("#capture").click();
	const download = await downloadPromise;
	const imagePath = testInfo.outputPath("preview.webp");
	await download.saveAs(imagePath);
	const bytes = await readFile(imagePath);
	const dimensions = await page.evaluate(
		async (data) => {
			const image = await createImageBitmap(
				new Blob([new Uint8Array(data)], { type: "image/webp" })
			);
			const dimensions = [image.width, image.height];
			image.close();
			return dimensions;
		},
		[...bytes]
	);
	expect(dimensions).toEqual([1280, 720]);
	expect(bytes.byteLength).toBeGreaterThan(15_000);
	expect(errors).toEqual([]);
	await testInfo.attach("Preview", { path: imagePath, contentType: "image/webp" });
});
