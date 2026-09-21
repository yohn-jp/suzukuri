# Releasing Suzukuri

This is the operational procedure for cutting a Suzukuri release. It
complements `.github/agent-governance/change-workflow.md` (merge/release
safety, section 10) and does not replace it.

## 1. Prepare the release branch

- Branch from current `main`: `release/<semver>` (e.g. `release/0.2.1`).
  `release/*` is one of the two branch-naming exceptions to the governed
  `<type>/<issue-number>-<slug>` convention (the other is `epic/*`).
- Bump `version` in `package.json` to the target semver.
- Add `docs/releases/<semver>.md` with `## Summary`, `## Added`,
  `## Changed`, `## Fixed`, `## Breaking changes / migration`,
  `## Upgrade`, and `## Release verification` sections. Use
  `docs/releases/0.2.0.md` as the structural template.
- Fix any pre-existing breakage found while running the required
  verification below; a release PR is a valid place to land small
  unrelated fixes discovered during release verification, not to expand
  scope beyond that.

## 2. Run required local verification

```bash
pnpm run verify
```

This builds the package, checks packed contents, installs the tarball into
an isolated consumer, runs the repository profiles through the installed
CLI, and verifies an external TypeScript caller can consume stable
provenance. Do not open the release PR until this passes.

## 3. Open the release PR

- Use `inari pr create` (not raw `gh pr create`) so the PR carries the
  `inari:template` marker required by `.github/inari/pull-requests/release.json`
  and passes `validate-pr`.
- Base: `main`. Head: `release/<semver>`.
- Fill every template section: target version, version bump class
  (patch/minor/major), release notes (link `docs/releases/<semver>.md`),
  breaking changes/migration (or explicit `None.`), publish plan, post-
  release verification checks, and tracking (linked Issue, or `None.`).
- Merge only after required CI and review pass. Re-check base/head and CI
  freshness immediately before merging (change-workflow.md section 10);
  do not merge on a prior green state alone.

## 4. Cut the GitHub Release

- After the release PR merges, create GitHub Release `v<semver>` from the
  resulting merge commit on `main`.
- This triggers `.github/workflows/publish.yml`, which:
  1. builds and tests the package;
  2. packs exactly one tarball;
  3. runs `scripts/verify-release-certification.mjs` against it, which
     fails closed unless the release tag, the checked-out source SHA, and
     the packed tarball's SHA-256 digest all match `package.json`'s
     version and the actual commit/artifact;
  4. smoke-tests that same tarball;
  5. publishes those exact bytes to npm via Trusted Publishing (OIDC) —
     no long-lived npm token is used.

## 5. Verify publication

- `npm view suzukuri version` reports the target version.
- `npx --yes suzukuri@<semver> --version` prints the target version.
- `npx --yes suzukuri@<semver> skill` runs without error.
- Update a global install if one is used for local testing:
  `npm install --global suzukuri@<semver>`.

## 6. Follow-up documentation PRs

A release verification section, migration note, or usage-doc gap
discovered only after publication is a small separate documentation PR
(branch `docs/<issue-number>-<slug>` or a bugfix-style branch tied to its
own Issue), not a reason to reopen or amend the release PR/tag.

## Notes

- Never publish outside the tag-triggered `publish.yml` path; there is no
  supported manual `npm publish` flow, and the certification script exists
  specifically to fail closed if source/tag/artifact ever diverge.
- Node.js version support floors are release-facing breaking changes; call
  them out explicitly in `## Breaking changes / migration` even when
  already required by an earlier release.
