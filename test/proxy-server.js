const { createServer } = require("node:http");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const MINECRAFT_JAR_URL =
	"https://piston-data.mojang.com/v1/objects/fd19469fed4a4b4c15b2d5133985f0e3e7816a8a/client.jar";
const ENDPOINT = "/proxy/minecraft-jar";

/** Local development helper: requests cannot select another destination or follow redirects. */
function createMinecraftProxyServer({ fetchResource = fetch } = {}) {
	return createServer(async (req, res) => {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");

		if (req.url !== ENDPOINT) {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end(`Only ${ENDPOINT} is available`);
			return;
		}
		if (req.method === "OPTIONS") {
			res.writeHead(204, { "Access-Control-Max-Age": "600" });
			res.end();
			return;
		}
		if (req.method !== "GET") {
			res.writeHead(405, { Allow: "GET, OPTIONS", "Content-Type": "text/plain" });
			res.end("Method not allowed");
			return;
		}

		const controller = new AbortController();
		const abort = () => {
			if (!res.writableEnded) controller.abort();
		};
		res.on("close", abort);
		try {
			const response = await fetchResource(MINECRAFT_JAR_URL, {
				method: "GET",
				redirect: "error",
				signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
			});
			if (!response.ok || !response.body) {
				await response.body?.cancel();
				res.writeHead(502, { "Content-Type": "text/plain" });
				res.end("Minecraft download failed");
				return;
			}
			res.setHeader("Content-Type", "application/java-archive");
			await pipeline(Readable.fromWeb(response.body), res);
		} catch (error) {
			if (!controller.signal.aborted) {
				console.error("Minecraft proxy failed:", error);
				if (!res.headersSent) {
					res.writeHead(502, { "Content-Type": "text/plain" });
					res.end("Minecraft download failed");
				} else res.destroy();
			}
		} finally {
			res.off("close", abort);
		}
	});
}

function listenOptions(defaultPort, env = process.env) {
	const host = env.HOST || "127.0.0.1";
	if (host !== "127.0.0.1" && host !== "::1") {
		throw new Error("Minecraft proxy HOST must be 127.0.0.1 or ::1");
	}
	const port = Number(env.PORT ?? defaultPort);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error("Minecraft proxy PORT must be an integer between 0 and 65535");
	}
	return { host, port };
}

function startMinecraftProxy(defaultPort = 3000) {
	const { host, port } = listenOptions(defaultPort);
	const server = createMinecraftProxyServer();
	server.listen(port, host, () => {
		const address = server.address();
		const actualPort = address && typeof address === "object" ? address.port : port;
		console.log(
			`Minecraft proxy: http://${host === "::1" ? "[::1]" : host}:${actualPort}${ENDPOINT}`
		);
	});
	return server;
}

module.exports = { createMinecraftProxyServer, listenOptions, startMinecraftProxy };
if (require.main === module) startMinecraftProxy();
