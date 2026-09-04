# Reproducible build and release baseline

## Pinned prerequisites

- macOS 13 or newer on Apple Silicon
- Node.js `20.19.4` and npm 10 (`.nvmrc` and `package-lock.json`)
- Rust `1.88.0` (`rust-toolchain.toml` and `Cargo.lock`)
- Xcode Command Line Tools and Homebrew `protobuf`

Install the prerequisites:

```sh
xcode-select --install
brew install protobuf
nvm install
nvm use
```

## Clean verification

```sh
npm ci
npm --prefix mcp-server ci
npm run check
```

`check` runs TypeScript type checking, the mocked frontend suite, the production frontend build, MCP tests, and locked Rust backend tests. Real-provider tests are deliberately separate because they require credentials or a local endpoint: run `npm run test:llm` only in a controlled environment.

Verify unsigned macOS packaging with:

```sh
npm run package:macos
```

Outputs appear below `src-tauri/target/release/bundle/` and are ignored by Git. CI repeats the checks on macOS, Linux, and Windows and performs an unsigned Apple Silicon packaging check on `macos-14`.

## Release procedure

1. Sync upstream through the policy in `FORK_AND_UPSTREAM.md` and pass CI.
2. Update the same SemVer version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
3. Run the clean verification and packaging commands above.
4. Review `git status --ignored`; it must not include a vault, `.llm-wiki`, LanceDB data, `app-state.json`, environment files, keys, or certificates.
5. Create and push a signed `vX.Y.Z` tag. The release workflow builds and publishes bundles. Signing/notarization values belong only in GitHub Actions secrets.
6. Record the source commit, upstream commit, checksums, supported architectures, known issues, and fork modifications in the release notes. Attach or link the corresponding GPLv3 source.

Unsigned local packages are suitable for smoke testing only. Public macOS releases should be Developer ID signed and notarized.
