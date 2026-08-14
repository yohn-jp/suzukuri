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

## Source views

The package exports an explicit TypeScript source adapter with versioned symbol-index and selected-symbol views. `generic-text` is a separate, explicitly selected adapter with a weaker contract: it preserves normalized text only and does not claim declaration, type, or containment semantics. A TypeScript parse failure never selects `generic-text` automatically.

```ts
import { createSourceProjectionCore } from "@yohn-jp/suzukuri";

const core = createSourceProjectionCore();
const result = core.project({
  source: { identity: "src/example.ts", content: "export const answer: number = 42;" },
  adapter: "typescript-source",
  view: "typescript-symbol-index",
  budget: 4096,
  renderer: "json",
});
```

## Repository-local profiles

The v0 profile document is `.suzukuri/profiles.json` (or a path supplied with `--profiles`). Its schema is JSON and has one versioned top-level document:

```json
{
  "schemaVersion": 1,
  "profiles": [
    {
      "name": "text-value",
      "description": "Text observation rendered as stable machine JSON.",
      "source": {
        "description": "Caller-supplied UTF-8 text.",
        "mediaType": "text/plain"
      },
      "adapter": "profile-text",
      "view": "profile-text",
      "budget": { "unit": "utf8-bytes", "maxBytes": 4096 },
      "renderer": "json"
    }
  ]
}
```

`name` is the exact resolver key. `source` describes the expected caller-supplied source; it does not contain source data. `adapter`, `view`, and `renderer` are explicit component ids or `{ "id", "version" }` identities. `budget` is a hard UTF-8 byte ceiling. Profile entries are validated and sorted by name; duplicate or ambiguous configuration fails explicitly. Profiles never select a task, infer an adapter, inherit another config, or persist source data.

The command surface uses stable JSON by default. `--format text` or `--human` is presentation-only:

```bash
suzukuri profile validate
suzukuri profile list
suzukuri profile show text-value
suzukuri profile run text-value --input observation.txt
suzukuri project --adapter profile-text --view profile-text --budget 4096 --renderer json --input observation.txt
suzukuri adapters
suzukuri views
```

The TypeScript entry point exports `parseProfileDocument`, `resolveProfile`, `runProfile`, `createProfileCore`, and the inspection helpers used by these commands. The caller supplies the source body to `runProfile`; the same `ProjectionCore` and registries are used for profile and low-level projection.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
