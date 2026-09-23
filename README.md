<p align="center">
  <img src="./docs/assets/readme/suzukuri-hero.webp" alt="Suzukuri — Bounded Semantic Views. Find the right information. Build with confidence." width="100%">
</p>

<p align="center">
  <a href="https://github.com/yohn-jp/suzukuri/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/yohn-jp/suzukuri/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/suzukuri"><img alt="npm" src="https://img.shields.io/npm/v/suzukuri"></a>
  <a href="https://www.npmjs.com/package/suzukuri"><img alt="Node" src="https://img.shields.io/node/v/suzukuri"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/npm/l/suzukuri"></a>
</p>

# Suzukuri

**Deterministic, bounded semantic views and verification evidence**

Suzukuri is a deterministic, bounded semantic view engine and repository
verification surface. It provides an explicit adapter → semantic-contract →
view → renderer pipeline, repository-mapped command execution, incremental
verification reuse, and machine-readable evidence for CLI and TypeScript
library consumers.

## Quick start

Requires Node.js 24 or newer.

```bash
npm install --global suzukuri

suzukuri --help
```

For an ephemeral invocation:

```bash
npx --yes suzukuri --help
```

## Start here

Read the [practical usage manual](./docs/USAGE.md) for repository command
execution, scoped verification reuse and evidence, the library entry point,
source views, repository-local profiles, and the product boundary.

## Analysis model

Suzukuri owns deterministic source decoding, semantic-contract validation, view
selection, bounded projection, repository-mapped execution, content
fingerprinting, and verification evidence. The caller owns task classification,
source/profile selection, repository declarations, execution policy, and
higher-level orchestration.

Every projection carries component identities, an authoritative SHA-256 source
digest, a stable projection digest, completeness, and machine-readable loss
metadata. Verification producers can additionally carry explicit input scopes
and tiers; unchanged stepped producers can reuse canonical PASS/FAIL evidence
without rerunning. A UTF-8 byte budget remains a hard projection ceiling:
required meaning is retained or projection fails explicitly with
`BUDGET_TOO_SMALL`.

## Development

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

`pnpm run verify` is the repository's authoritative local verification entry
point. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contribution
workflow.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
