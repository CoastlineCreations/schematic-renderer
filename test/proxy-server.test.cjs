const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test } = require("node:test");
const { createMinecraftProxyServer, listenOptions } = require("./proxy-server.js");

async function fixture(t, fetchResource) {
	const server = createMinecraftProxyServer({ fetchResource });
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(
		() =>
			new Promise((resolve) => {
				server.close(resolve);
				server.closeAllConnections();
			})
	);
	return `http://127.0.0.1:${server.address().port}`;
}

test("streams only the fixed Minecraft client and does not forward client credentials", async (t) => {
	const requests = [];
	const base = await fixture(t, async (target, options) => {
		requests.push({ target, options });
		return new Response("jar payload");
	});
	const response = await fetch(`${base}/proxy/minecraft-jar`, {
		headers: { Authorization: "Bearer local-only", Cookie: "session=local-only" },
	});
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "jar payload");
	assert.equal(response.headers.get("access-control-allow-origin"), "*");
	assert.equal(response.headers.get("content-type"), "application/java-archive");
	assert.equal(requests.length, 1);
	assert.equal(
		requests[0].target,
		"https://piston-data.mojang.com/v1/objects/fd19469fed4a4b4c15b2d5133985f0e3e7816a8a/client.jar"
	);
	assert.equal(requests[0].options.redirect, "error");
	assert.equal(requests[0].options.headers, undefined);
});

test("rejects arbitrary URLs, query targets and unsupported methods without upstream requests", async (t) => {
	let requests = 0;
	const base = await fixture(t, async () => {
		requests++;
		return new Response("unexpected");
	});
	for (const route of [
		"/https://example.com",
		"/proxy/minecraft-jar?url=http://127.0.0.1",
		"/proxy/minecraft-jar/../secrets",
	]) {
		const response = await fetch(`${base}${route}`);
		assert.equal(response.status, 404);
		await response.text();
	}
	const response = await fetch(`${base}/proxy/minecraft-jar`, { method: "POST", body: "payload" });
	assert.equal(response.status, 405);
	assert.equal(response.headers.get("allow"), "GET, OPTIONS");
	await response.text();
	assert.equal(requests, 0);
});

test("answers CORS preflights without downloading Minecraft", async (t) => {
	let requests = 0;
	const base = await fixture(t, async () => {
		requests++;
		return new Response("unexpected");
	});
	const response = await fetch(`${base}/proxy/minecraft-jar`, { method: "OPTIONS" });
	assert.equal(response.status, 204);
	assert.equal(response.headers.get("access-control-allow-methods"), "GET, OPTIONS");
	assert.equal(requests, 0);
});

test("reports unsuccessful upstream downloads as 502", async (t) => {
	const base = await fixture(t, async () => new Response("upstream unavailable", { status: 503 }));
	const response = await fetch(`${base}/proxy/minecraft-jar`);
	assert.equal(response.status, 502);
	assert.equal(await response.text(), "Minecraft download failed");
});

test("refuses network interfaces and invalid ports while preserving launcher defaults", () => {
	assert.deepEqual(listenOptions(8079, {}), { host: "127.0.0.1", port: 8079 });
	assert.deepEqual(listenOptions(3000, { HOST: "::1", PORT: "8079" }), { host: "::1", port: 8079 });
	assert.throws(() => listenOptions(3000, { HOST: "0.0.0.0" }), /HOST must be/);
	assert.throws(() => listenOptions(3000, { PORT: "70000" }), /PORT must be/);
});
