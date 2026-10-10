# Sectionr

A desktop app for creating pen-plotter artwork from 3D models. The Tauri app
handles positioning, preview and SVG export; a bundled Deno sidecar computes
the model projections.

## Build on GitHub

The **Build macOS app** workflow runs **manually only**. Commits and pull requests
do not trigger builds. It tests the code, builds the app and its compute sidecar,
verifies the bundle, and uploads an Apple Silicon Mac installer.

From this repository, using an authenticated GitHub CLI:

```sh
gh workflow run build-macos.yml --ref main
```

To run from any directory:

```sh
gh workflow run build-macos.yml --repo Shoray2002/sectionr --ref main
```

Follow the run and download its installer:

```sh
gh run watch --repo Shoray2002/sectionr
gh run download RUN_ID --repo Shoray2002/sectionr --dir ./build-download
```

Replace `RUN_ID` with the ID shown in the run URL or by
`gh run list --repo Shoray2002/sectionr --workflow build-macos.yml`.
To build another branch, replace `main` in the run command with that branch.

You can also use [Actions → Build macOS app → Run workflow](https://github.com/Shoray2002/sectionr/actions/workflows/build-macos.yml).
Once the run succeeds, download its `sectionr-macos-arm64-…` artifact, unzip it,
and open the `.dmg` to install Sectionr. Downloads are kept for 30 days.

These personal builds are ad-hoc signed, not Apple-notarized; macOS may display
a security approval prompt. Intel Macs, Windows builds and automatic app updates
are not configured.

## Local development

Use Node 22, Deno 2.8.3 and Rust 1.96.0 (the versions used by the GitHub build).
On an Apple Silicon Mac with Xcode Command Line Tools installed:

```sh
npm ci
npm run tauri -- dev
```

To build the app and `.dmg` locally:

```sh
mkdir -p src-tauri/binaries
APPLE_SIGNING_IDENTITY=- npm run dmg
```

To run the JavaScript tests:

```sh
node --test ./*.test.js scripts/clean-svg.test.js
deno run -A server/parallel-edges.test.js
```

See [SVG-CLEANUP.md](SVG-CLEANUP.md) for the export cleanup pass and the command
to clean existing Sectionr SVGs.
