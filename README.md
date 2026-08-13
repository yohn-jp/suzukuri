# Suzukuri

Suzukuri is a deterministic, bounded semantic view engine. It provides an explicit adapter → semantic-contract → view → renderer pipeline for CLI and TypeScript library consumers.

## Install

```bash
npm install -g @yohn-jp/suzukuri
```

## Usage

```bash
suzukuri --help
```

## Library

The package entry point exports the same versioned projection core used by the CLI:

```ts
import { ProjectionCore, createBudget, validationSuccess } from "@yohn-jp/suzukuri";
```

Projection is caller-driven. An adapter and view are always selected explicitly; the core never auto-detects adapters or silently falls back to another component. Ordinary projection is synchronous and does not require a daemon, database, network, or persistent source store.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
