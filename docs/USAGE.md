# Suzukuri usage

## Library

The package entry point exports the same versioned projection core used by the CLI:

```ts
import { ProjectionCore, createBudget, validationSuccess } from "suzukuri";
```

Projection is caller-driven. An adapter and view are always selected explicitly; the core never auto-detects adapters or silently falls back to another component. Ordinary projection is synchronous and does not require a daemon, database, network, or persistent source store.

## Source views

The package exports an explicit TypeScript source adapter with versioned symbol-index and selected-symbol views. `generic-text` is a separate, explicitly selected adapter with a weaker contract: it preserves normalized text only and does not claim declaration, type, or containment semantics. A TypeScript parse failure never selects `generic-text` automatically.

```ts
import { createSourceProjectionCore } from "suzukuri";

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

## Skill playbooks

`suzukuri skill` lists bounded operational playbooks derived from the repository's AGENTS.md execution contract; `suzukuri skill <scenario>` prints that scenario's steps. Like every other command, output is JSON by default and `--human`/`--format text` selects presentation-only text:

```bash
suzukuri skill
suzukuri skill bounded-implementation
suzukuri skill git-isolation --human
```

## Progressive help and runtime checks

Help is wired at every command depth from one command table (`src/command-contract.ts`), the same table execution dispatch reads, so a command can never exist without being documented or vice versa:

```bash
suzukuri --help                  # domain overview
suzukuri profile --help          # that domain's operations
suzukuri profile show --help     # that leaf command's usage and example
suzukuri skill --help            # skill scenario list
suzukuri skill git-isolation --help  # one scenario's summary
suzukuri --help=full             # the complete command and option reference
suzukuri --help=json             # the same reference as machine-readable JSON
```

`suzukuri --version` prints a namespaced version string, and `suzukuri --diagnose` (alias `--doctor`) reports standalone runtime readiness as JSON.

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

Execution commands in `.suzukuri/commands.json` may declare `inputs` as a non-empty array of repository-relative file or directory paths, for example `"inputs": ["src", "package.json"]`. Paths are literal and include files beneath a named directory. A stepped command may declare command-level inputs, step inputs, or both; the existing command-level cache uses their union. If a step has no inputs and the command has none, the cache retains its repository-wide fingerprint. Only tracked and non-ignored untracked files contribute to a scoped fingerprint. Omit `inputs` to retain repository-wide behavior.

## Reusable verification evidence

Reusable `test-result` and `verification-result` JSON results include canonical evidence when Suzukuri can prove a stable input fingerprint. Single-producer results expose `evidence`; stepped results expose evidence on each `steps` entry. The evidence records fixed-size SHA-256 identities for the producer definition, input fingerprint, bounded semantic result, and evidence itself, plus execution state (`executed` or `reused`) and the explicitly declared tier when present. `producerIdentity` hashes the registered command name and exact normalized producer definition; step names remain on their corresponding `steps` entries.

Evidence hashes are lowercase SHA-256 hex digests over Suzukuri's canonical stable JSON representation. The identities are computed as follows:

```text
producerIdentity = SHA-256(stableJsonStringify({ commandName, commandDefinition }))
resultIdentity = SHA-256(stableJsonStringify({ exitCode, signal, result }))
identity = SHA-256(stableJsonStringify({ version, producerIdentity, inputFingerprint, resultIdentity }))
```

For a stepped producer, `commandDefinition` is that step's normalized definition and effective input scope. `result` is its bounded projected semantic result. Reuse preserves the evidence identity and original PASS/FAIL outcome while changing only `execution` to `reused`; the legacy top-level `reused` marker remains available for single-result cache hits.

A consumer can validate evidence by comparing the producer definition identity and input fingerprint with the current registered producer and its declared input scope, then checking the result identity and evidence identity. Tier is descriptive metadata and is not inferred. Timestamps, branch names, worktree paths, commit identities, and raw producer logs are not evidence validity inputs. If a complete stable fingerprint cannot be obtained, Suzukuri runs the producer without emitting reusable evidence.
