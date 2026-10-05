# Publishing the two forks to npm

Publish Nucleation first, then update and publish schematic-renderer. GitHub repository
ownership does not grant publishing access to the existing unscoped npm packages.
Use an npm user or organization scope you control. The examples below assume you
have publishing rights to `@coastlinecreations`; replace that scope if needed.
The example versions must not already exist under those package names.

`@coastlinecreations/nucleation@0.10.24` is now published and pinned by this renderer.
To publish the renderer against that release, start at step 2. Step 1 records the
Nucleation release process; use a new unused version throughout before publishing
another Nucleation release.

Prerequisites: Node 24, npm, Rust with the `wasm32-unknown-unknown` target,
and an npm account with the required publishing/2FA setup. Authenticate with
`npm login --registry=https://registry.npmjs.org`.

## 1. Build and publish Nucleation

Run from the Nucleation checkout, not from schematic-renderer:

```sh
rustup target add wasm32-unknown-unknown
RUSTC_WRAPPER= bash tools/package-npm.sh dist/npm
RUSTC_WRAPPER= NUCLEATION_WASM_FEATURES=bridge bash tools/package-npm.sh dist/npm-renderer
mkdir -p dist/npm/renderer
cp -R dist/npm-renderer/. dist/npm/renderer/
rm -f dist/npm/renderer/package.json dist/npm/renderer/.build-stamp

npm pkg set --prefix dist/npm \
  name='@coastlinecreations/nucleation' \
  version='0.10.24' \
  repository.url='git+https://github.com/CoastlineCreations/nucleation.git' \
  homepage='https://github.com/CoastlineCreations/nucleation'

node tools/test-npm-package.mjs dist/npm --with-renderer
cd dist/npm
npm pack --dry-run
npm publish --access public --registry=https://registry.npmjs.org
```

Publish this assembled `dist/npm` directory. The `nucleation:local` command creates
a private development archive and is not a release artifact. The assembly script
resets the generated manifest on rebuild, so apply the package name and version
after building. Keep the upstream author/license attribution.

For subsequent releases, select a new version and record the release metadata in
the fork's packaging configuration or a dedicated npm release workflow. The
existing native/Python release pipeline additionally requires matching Cargo and
Python versions; it is not required for this manual npm-only procedure.

## 2. Point the renderer at the published fork

Run from the schematic-renderer checkout, after the Nucleation publication succeeds:

```sh
npm pkg set \
  name='@coastlinecreations/schematic-renderer' \
  version='1.8.0' \
  'dependencies.nucleation=npm:@coastlinecreations/nucleation@0.10.24'
npm install
npx playwright install chromium
npm run verify
npm pack --dry-run
```

The npm alias keeps existing `import ... from "nucleation"` statements and emitted
TypeScript declarations working while consumers install your scoped fork. Commit
both `package.json` and `package-lock.json`, then push before publishing:

```sh
git add package.json package-lock.json
git commit -m "Prepare scoped renderer release with Nucleation fork"
git push origin master
npm publish --access public --registry=https://registry.npmjs.org
```

The renderer's `files` list ships `dist`; keep all lazy model chunks alongside the
entry files. Consumers can then install:

```sh
npm install @coastlinecreations/schematic-renderer
```

## Existing GitHub release workflows

- Nucleation's `v*` tag workflow still refers to the unscoped `nucleation` package
  and also publishes to crates.io and PyPI. Adapt package names, registry checks
  and authentication before using that workflow for this fork.
- schematic-renderer's workflow runs when a GitHub Release is published and uses
  `NPM_TOKEN`. Adapt the package name and npm credentials before using it. Avoid
  triggering it for a version already published manually.
- For future automation, npm trusted publishing can replace a long-lived npm
  token. Configure it for the exact GitHub organization, repository and workflow,
  using the Node/npm versions required by npm's current documentation.

References: [public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/),
[npm aliases](https://docs.npmjs.com/cli/v11/using-npm/package-spec/),
[trusted publishing](https://docs.npmjs.com/trusted-publishers/).
