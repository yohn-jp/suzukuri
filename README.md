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

**Deterministic, bounded semantic views**

Suzukuri is a deterministic, bounded semantic view engine. It provides an explicit adapter → semantic-contract → view → renderer pipeline for CLI and TypeScript library consumers.

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

Read the [practical usage manual](./docs/USAGE.md) for the library entry
point, source views, repository-local profiles, the product boundary, and
the v0 support matrix.

## Analysis model

Suzukuri owns deterministic source decoding, semantic-contract validation, view selection, bounded projection, provenance, and rendering. The caller owns task classification, adapter/view selection, source lifetime, execution policy, and any higher-level orchestration.

Every projection carries component identities, source provenance when supplied, a stable projection digest, completeness, and machine-readable loss metadata. A UTF-8 byte budget is a hard ceiling: required meaning is retained or the projection fails explicitly with `BUDGET_TOO_SMALL`.

## Development

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

`pnpm run verify` is the repository's authoritative local verification entry point. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contribution workflow.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
