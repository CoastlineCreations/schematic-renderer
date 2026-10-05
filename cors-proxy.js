// Compatibility launcher for the local Minecraft download helper.
// Usage: node cors-proxy.js (PORT defaults to 8079; HOST must be loopback).
const { startMinecraftProxy } = require("./test/proxy-server.js");
startMinecraftProxy(8079);
