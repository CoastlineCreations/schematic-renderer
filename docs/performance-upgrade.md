# Dependency and rendering upgrade

## Dependencies

- Vite 4.5.14 → 8.3.2, using Rolldown, an ES module configuration, and worker plugin factories.
- Three.js 0.184.0 → 0.186.1, matching types 0.186.0 and postprocessing 6.39.5.
- Nucleation 0.2.18 → **0.10.4**, pinned intentionally.
- Compatible maintenance updates for the test, lint, formatting, DOM and archive dependencies.
- Removed unused packages and the obsolete creative-controls dependency. Creative controls now share the renderer's Three.js version. Development-only packages no longer appear in runtime dependencies. The old generic CORS proxy was replaced by a loopback-only Node helper for the fixed Minecraft client URL; npm audit reports no vulnerabilities.

Nucleation 0.10.4 is the newest published version verified to include both simulation and circuit WASM functions. Every published later release through 0.10.24 lacks the `MchprsWorld_*` and `CircuitBuilder_*` exports, although the JavaScript API declares them. Calling their constructors in 0.10.24 throws `wasm.MchprsWorld_create is not a function` or `wasm.CircuitBuilder_create is not a function`. Upgrading this pin requires real WASM simulation and circuit tests, not just TypeScript checks.

The local 0.10.24 fork now fixes that packaging defect and passes those real WASM tests. `npm run nucleation:local` builds, tests and installs it without changing the registry pin. See [the fork workflow and extraction benchmark](nucleation-fork.md).

## Rendering changes

- Entity models use 369 independent lazy imports. Concurrent requests share a load; failed loads can be retried. The UMD distribution remains self-contained for model data.
- Batched meshing uses up to four concurrent workers with a bounded chunk budget and fair worker reuse. Completion, cancellation, worker errors and timeouts release their buffers.
- Repeated rebuild requests are coalesced. Obsolete builds cannot replace the latest scene. Objects sharing a mesh builder cannot overwrite one another's palettes.
- Simulation synchronization rebuilds only the affected schematic once. Continuous ticks retain the latest queued state while allowing the active build to finish.
- Inspector timers, keyboard handlers and late asynchronous setup are cleaned up on disposal. Creative controls stop processing disabled input and release their listeners.

## Measurements

Reference: the working tree before this upgrade, including the earlier warning fixes. Bundle gzip sizes use level 9 consistently.

| Measurement                 |                          Before |                After |
| --------------------------- | ------------------------------: | -------------------: |
| Initial ES JavaScript       |                11,802,651 bytes |      1,446,640 bytes |
| Initial ES JavaScript, gzip |                 2,489,668 bytes |        387,668 bytes |
| Eight simultaneous rebuilds | did not settle within 5 seconds | approximately 185 ms |

The initial ES reduction is approximately **88% uncompressed / 84% gzip**. Deploy the entire `dist` directory: requested model chunks and optional renderer modules must remain next to the entry file. Total model data is unchanged; it is downloaded only when requested.

Runtime measurements used the rendering-features sample, Chromium's software WebGL renderer, a 1440×1100 viewport and local Vite servers. Sequential rebuild times were similar. These small-sample measurements do not establish a hardware FPS improvement or a large-world loading speedup.

## Nucleation compatibility

Existing renderer entry points use typed compatibility adapters over the shared native module. Initialization remains explicit for standalone wrapper consumers:

```ts
import { initializeNucleationWasm, SchematicWrapper } from "schematic-renderer";

await initializeNucleationWasm();
const schematic = new SchematicWrapper();
schematic.set_block(0, 0, 0, "minecraft:stone");
```

The renderer initializes this automatically. Initialization is shared and retryable. Browser UMD consumers can provide the initialized native module as `globalThis.Nucleation`, alongside `globalThis.THREE`.

Nucleation 0.10.4 has two relevant limitations:

- Its palette API omits block properties. The adapter reconstructs a compact render snapshot using bounded chunk reads, then reuses it until mutation. The first scan is synchronous. Direct edits through `wrapper.native` require `wrapper.invalidateCaches()` afterwards; wrapper mutation methods invalidate automatically.
- Native handles use garbage-collection finalizers. On 0.10.4, compatibility `free()` methods release JavaScript references and render caches. On the local 0.10.24 fork, owned schematic contents are also cleared immediately through `clearContents()` while opaque handle destruction remains with the finalizer.

The legacy simulation `get_truth_table()` method has no native equivalent in this release. Native graph exports now expose the generated `RedstoneGraph` API. Core simulation, custom IO, circuit execution, region attachment, diffs, builders, block states, nested SNBT and schematic/litematic round-trips have regression coverage.

CommonJS loading was checked separately. Three.js 0.186 emits its upstream `THREE_CJS_DEPRECATED` warning for `require("three")`; use ES imports to avoid that deprecated loading path. The warning is not suppressed.

## Validation

`npm run verify` checks formatting, lint with zero tolerated warnings, both TypeScript configurations, unit and real WASM tests, five local proxy tests, library generation, and three browser tests. The local fork passes 408 unit/WASM tests and all eight proxy/browser tests. Browser coverage exercises source, ES and classic UMD distributions: entity families, concurrent rebuilds, repeated reopen, local-file loading and populated 1280×720 image export.
