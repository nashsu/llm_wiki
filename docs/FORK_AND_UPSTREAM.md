# Fork and upstream policy

This repository is a GPLv3 fork of [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki). It preserves the upstream copyright notice, project credits, and the complete `LICENSE`. Modified distributions remain subject to GPLv3; release source must correspond to the distributed binaries.

## Remotes

Configure a clone so `origin` is the maintained fork and `upstream` is the source project:

```sh
git remote set-url origin https://github.com/simonislee/llm_wiki.git
git remote add upstream https://github.com/nashsu/llm_wiki.git
git remote set-url --push upstream DISABLED
git remote -v
```

Never force-push `main`. Feature branches are merged through pull requests after the checks in `.github/workflows/ci.yml` pass.

## Sync procedure

1. Start from a clean checkout of fork `main`.
2. Run `git fetch --prune upstream`.
3. Create `sync/upstream-YYYY-MM-DD` from `origin/main`.
4. Merge `upstream/main` with `--no-ff`; preserve upstream authorship and resolve fork-specific conflicts explicitly.
5. Run `npm ci`, `npm --prefix mcp-server ci`, and `npm run check`.
6. Open a pull request recording the upstream commit SHA and noteworthy conflicts.

Rebasing published `main` is intentionally avoided: merge commits retain an auditable upstream boundary and make rollback straightforward.

## Attribution and release obligations

- Keep `LICENSE`, upstream copyright notices, and README credits.
- Mark fork modifications in release notes and retain Git history.
- Publish the exact source revision and build instructions for every distributed binary.
- Do not add terms that restrict recipients' GPLv3 rights.

This policy is operational guidance, not legal advice.
