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

## Product boundary and loss semantics

Suzukuri owns deterministic source decoding, semantic-contract validation, view selection, bounded projection, provenance, and rendering. The caller owns task classification, adapter/view selection, source lifetime, execution policy, and any higher-level orchestration. Suzukuri does not import caller task or policy state, infer a view, auto-select a fallback adapter, persist source data, or call a model/network service.

Every projection carries component identities, source provenance when supplied, a stable projection digest, completeness, and machine-readable loss metadata. A UTF-8 byte budget is a hard ceiling. Required meaning is retained or the projection fails explicitly with `BUDGET_TOO_SMALL`; optional meaning is reduced only through the selected view's declared priorities and reductions. `generic-text` is an explicit weak-contract adapter, not an automatic recovery path.

## v0 support matrix

| Semantic family        | Explicit adapters              | Views                                            | Input boundary                  |
| ---------------------- | ------------------------------ | ------------------------------------------------ | ------------------------------- |
| Repository profiles    | `profile-text`, `profile-json` | text, lines, text summary, JSON value, JSON keys | caller-supplied text/JSON       |
| Git                    | `git-diff`, `git-status`       | summary, files, hunks                            | unified diff / porcelain status |
| Test results           | `vitest`                       | summary, failures                                | representative Vitest text/JSON |
| Diagnostics            | `typescript-diagnostics`       | errors, files                                    | TypeScript diagnostic text/JSON |
| TypeScript source      | `typescript-source`            | symbol index, explicitly selected symbol detail  | caller-supplied TypeScript      |
| Explicit weak fallback | `generic-text`                 | normalized text                                  | caller-selected generic text    |

The support matrix is intentionally finite: unsupported producers or languages fail validation rather than silently changing semantic contracts.

## Conformance and release evidence

`pnpm run conformance` runs the executable v0 fixture suite and reports byte reduction, projection latency, automatic fallback rate, required/preserved meaning, and comparison with naive byte truncation. `pnpm run verify` additionally builds the package, checks packed contents, installs the tarball into an isolated consumer, runs all five repository profiles through the installed CLI, and verifies an external TypeScript caller can consume stable provenance without caller state crossing the boundary.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
