import { defineConfig } from "vite";
import path from "path";
import fs from "fs";

// Inlines .wasm files as base64 data URLs so the library bundle is self-contained.
const wasmInlinePlugin = () => ({
	name: "wasm-inline",
	enforce: "pre",
	load(id) {
		const cleanId = id.split("?")[0];
		if (cleanId.endsWith(".wasm")) {
			const base64 = fs.readFileSync(cleanId).toString("base64");
			return {
				code: `export default "data:application/wasm;base64,${base64}";`,
				map: null,
			};
		}
	},
});

// Preserve relative inspector extension URLs in both ES and UMD builds.
const inspectorModuleUrlPlugin = () => ({
	name: "inspector-module-url",
	apply: "build",
	transform(code, id) {
		if (id.endsWith("/three/examples/jsm/inspector/tabs/Settings.js")) {
			return {
				code: code.replaceAll("import.meta.url", "__schematicRendererModuleUrl"),
				map: null,
			};
		}
	},
});

export default defineConfig({
	server: {
		port: 4000,
		open: false,
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "credentialless",
		},
		fs: {
			allow: ["..", "../.."],
		},
	},
	root: "./test/pages",
	publicDir: "../public",
	build: {
		outDir: "../../dist",
		copyPublicDir: false,
		emptyOutDir: true,
		lib: {
			entry: path.resolve(import.meta.dirname, "src/index.ts"),
			name: "SchematicRenderer",
			fileName: (format) => `schematic-renderer.${format}.js`,
		},
		sourcemap: false,
		rolldownOptions: {
			external: ["three", "nucleation"],
			output: [
				{
					format: "es",
					codeSplitting: true,
					intro: "const __schematicRendererModuleUrl = import.meta.url;",
				},
				{
					format: "umd",
					name: "SchematicRenderer",
					codeSplitting: false,
					globals: { three: "THREE", nucleation: "Nucleation" },
					intro:
						"const __schematicRendererModuleUrl = typeof document !== 'undefined' ? (document.currentScript?.src || new URL('schematic-renderer.umd.js', document.baseURI).href) : typeof location !== 'undefined' ? location.href : require('u' + 'rl').pathToFileURL(__filename).href;",
				},
			],
		},
	},
	plugins: [wasmInlinePlugin(), inspectorModuleUrlPlugin()],
	define: {
		global: "globalThis",
	},
	optimizeDeps: {
		exclude: ["nucleation", "@wasm/minecraft_schematic_utils", "@ffmpeg/ffmpeg", "@ffmpeg/util"],
	},
	worker: {
		format: "es",
		plugins: () => [wasmInlinePlugin()],
	},
	test: {
		root: "./",
		globals: true,
		environment: "happy-dom",
		include: ["src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}"],
		exclude: ["node_modules", "dist", "test/pages"],
		setupFiles: ["./src/test/setup.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov", "html"],
			reportsDirectory: "./coverage",
			exclude: [
				"node_modules/",
				"dist/",
				"test/",
				"**/*.d.ts",
				"**/*.test.ts",
				"**/*.spec.ts",
				"**/index.ts",
				"src/test/**",
			],
		},
	},
});
