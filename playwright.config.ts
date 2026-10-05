import { defineConfig } from "@playwright/test";

// Playwright forces FORCE_COLOR=1 in its workers. Avoid inheriting a conflicting
// NO_COLOR flag; this affects only the test runner and its child processes.
delete process.env.NO_COLOR;

export default defineConfig({
	testDir: "./test/browser",
	fullyParallel: false,
	workers: 1,
	// Separate browser workers isolate the graphics resources of each distribution.
	projects: [{ name: "source" }, { name: "es" }, { name: "umd" }],
	timeout: 60_000,
	use: {
		baseURL: "http://127.0.0.1:4011",
		viewport: { width: 1440, height: 1100 },
		launchOptions: { args: ["--enable-unsafe-swiftshader"] },
		trace: "retain-on-failure",
	},
	webServer: {
		command: "npm run start -- --host 127.0.0.1 --port 4011 --strictPort",
		url: "http://127.0.0.1:4011/preview.html",
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
