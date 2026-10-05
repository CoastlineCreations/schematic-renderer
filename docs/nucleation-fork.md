# Local Nucleation fork

The sibling `../nucleation` checkout is based on Nucleation 0.10.24. Its npm build now includes `simulation` alongside `bridge,mc-tick,meshing,voxelize`. The published 0.10.24 package declares MCHPRS and circuit methods but omits their WASM exports; rebuilding with the missing feature restores them.

The fork checks the actual WASM exports during package assembly, including cached builds. CI packs and extracts the npm archive, then tests the main and renderer-only entries. The main tests cover real lever-to-lamp propagation, typed circuit ON/OFF execution and schematic synchronization. Both entries exercise typed rendering, bounds, properties, buffer lifetime, round-trips and `clearContents()`.

## Use both local checkouts

Install Rust with the `wasm32-unknown-unknown` target and use the Node version required by this renderer. Then, from `schematic-renderer`:

```sh
rustup target add wasm32-unknown-unknown
npm run nucleation:local
npm run verify
```

The command builds both WASM entries, assembles a private local npm archive, tests that archive, and installs it into `node_modules`. It disables the fork's default `sccache` wrapper unless `RUSTC_WRAPPER` is explicitly set. Set `NUCLEATION_PATH` to use another checkout. After both outputs have already been built, `npm run nucleation:local -- --skip-build` only packs, tests and installs them.

The committed dependency and `package-lock.json` retain **0.10.4**, the last verified published version with simulation. The local install uses **0.10.24-local.<commit>**, including the checkout's current uncommitted changes. It does not publish anything or make other installations depend on an absolute local path. A normal dependency reinstall can restore the registry version; rerun `nucleation:local` afterwards. To explicitly restore it:

```sh
npm ci
```

A permanent distribution change requires publishing a versioned fork artifact, then pinning that artifact in this renderer. No fork package has been published by this work.

## Renderer behavior

When `renderRegionsJson()` and `regionBlockIndices()` exist, the renderer obtains palettes and ordinary bounds from metadata and reads block indices only as chunks are requested. Properties and region-local palette indices are preserved. Typed buffers returned to workers are independent copies. Mutation invalidates existing iterators before another native read. The 0.10.4 JSON compatibility path remains available automatically.

The typed cache retains at most 64 sections (4 MiB of expanded block tuples). Native reads are capped at 65,536 indices and at eight times the useful row data, avoiding excessive copies in wide regions. Explicit full-snapshot requests still materialize the full result.

The latest native region precedence applies inside each region's actual content bounds. Allocated air padding does not hide lower regions; air holes inside those bounds still do. Iterators count candidate chunks, including potentially empty ones, to avoid scanning the world during construction.

Renderer scans yield after at most 64 candidates or 8 ms between chunks, including empty or bounds-culled chunks. Cancellation is checked before native reads resume.

`SchematicWrapper.free()` uses `clearContents()` only for owned handles. Constructors and parser results own their handles; `fromNative()` borrows by default, with explicit `"owned"` transfer available. Native aliases remain valid empty handles after owned cleanup. Finalizers still destroy the opaque handle; no manual raw WASM destructor is called. WASM memory pages do not shrink merely because storage becomes reusable.

Freeing a borrowed wrapper leaves its owner's cache and active iterators intact.

## Reproduce extraction measurements

```sh
npm run benchmark:nucleation
BENCHMARK_LAYOUT=sparse npm run benchmark:nucleation
```

The default volume is 96³ (884,736 cells), with three alternating runs of each extraction path on the same local WASM engine. Dense data contains 884,736 blocks; sparse data contains 1,729. The benchmark checks matching bounds, counts and coordinate/state checksums. It reports first-chunk latency, total extraction time, native calls and transfer sizes. `BENCHMARK_SIDE` and `BENCHMARK_ROUNDS` change the dimensions and repetitions.

These measurements exclude file parsing, meshing, GPU upload and display. They establish an extraction improvement, not an FPS claim.

Measured medians on this machine with Node 24.19.0 and Rust 1.99.0:

| Fixture                               | JSON: first chunk | Typed: first chunk | JSON: full extraction | Typed: full extraction |
| ------------------------------------- | ----------------: | -----------------: | --------------------: | ---------------------: |
| Dense, 884,736 blocks                 |            927 ms |            0.83 ms |                935 ms |                28.9 ms |
| Sparse, 1,729 blocks in 884,736 cells |            803 ms |            0.54 ms |                803 ms |                18.9 ms |

That is approximately **32× faster dense extraction** and **42× faster sparse extraction** in these fixtures. [Raw runs and environment](benchmarks/nucleation-extraction.json) include matching checksums and native transfer counts. Both paths use the same rebuilt 0.10.24 engine, isolating the renderer's extraction change from other native upgrades.

## Remaining limits

- Exact visible bounds can still require a synchronous typed scan when a palette contains `minecraft:cave_air` or `minecraft:void_air`, which the renderer excludes but native content bounds include. Even unused palette entries can trigger this scan.
- Candidate chunk enumeration still follows region content bounds. Extremely sparse regions spanning very large volumes can remain expensive.
- The main fork WASM is 18,179,648 bytes versus 14,017,476 bytes for 0.10.4; the separate renderer-only WASM is 12,077,583 bytes. This integration keeps the full entry because simulation is part of the renderer API.
- Upstream Rust builds emit unused-code and documentation warnings. These are separate from `npm run verify`; this focused fork fixes packaging and integration rather than refactoring unrelated native modules.
