# M1-WP5B — Rules reference on-demand relay

Manual, one-shot publication of `companion-rules-reference.json` to the private GitHub relay. No daemon, no polling, no F6 coupling.

## Remote artifact

| Item | Value |
|------|--------|
| **Path** | `m0/rules-reference.json` |
| **Repo / branch** | `NoReturns/OpenXcom-Aster-Relay` @ `main` (production cooperative defaults) |
| **Wire format** | JSON envelope + embedded WP5 reference (see below) |

## Local prerequisites

1. Export rules locally (Geoscape/Basescape **Ctrl+Shift+R**) → `local/m0/companion-rules-reference.json`
2. Authenticated `gh` CLI (`gh auth status`)

## Manual publication command

Dry-run (default — validates only, **0** GitHub API calls):

```powershell
node "E:\Open X-Com Companion\companion\m0-publish\publish-rules-reference-once.cjs" --dry-run --path "E:\Open X-Com Companion\local\m0\companion-rules-reference.json"
```

One-shot publish (**2** GitHub API calls: `GET` content SHA + `PUT` content):

```powershell
node "E:\Open X-Com Companion\companion\m0-publish\publish-rules-reference-once.cjs" --publish --path "E:\Open X-Com Companion\local\m0\companion-rules-reference.json"
```

Optional campaign guard (32-hex `campaign_id` must match local file):

```powershell
node "E:\Open X-Com Companion\companion\m0-publish\publish-rules-reference-once.cjs" --publish --expect-campaign-id "<campaign_id>" --path "E:\Open X-Com Companion\local\m0\companion-rules-reference.json"
```

Isolated tests use `--isolation-config` pointing at `config/m1-34e-relay-isolation.example.json` (non-production paths).

**Do not run `--publish` against production during automated tests.**

## Remote wire format

```json
{
  "relay_envelope": {
    "schema_version": 1,
    "artifact": "companion-rules-reference-relay",
    "publish_status": "complete",
    "published_at_ms": 1700000000000,
    "campaign_id": "<32 hex>",
    "content_revision_sha256": "<64 hex>",
    "research_revision_sha256": "<64 hex>",
    "ruleset_revision_sha256": "<64 hex>"
  },
  "reference": { "...": "WP5 companion-rules-reference document" }
}
```

Validation runs on the embedded `reference` using `lib/rules-reference-export.cjs` (research-gated schema, sorted items, size cap). Envelope digests must match `reference.identity`.

## Stale detection (remote Companion)

Campaign id alone is **insufficient**. Treat remote data as current only when **all** of the following hold:

1. `relay_envelope.publish_status === "complete"`
2. Envelope validates against embedded `reference` (`validateRulesReferenceRelayEnvelope`)
3. Binding checks (`evaluateRemoteRulesReferenceFreshness` in `lib/rules-reference-relay-publish.cjs`):
   - `campaign_id` matches active campaign (if known)
   - `content_revision_sha256` matches expected entitlement revision
   - Optionally `research_revision_sha256` and `ruleset_revision_sha256` match local export / marker

Retrieve via authenticated `gh api` (same tooling as tactical relay):

```text
GET repos/NoReturns/OpenXcom-Aster-Relay/contents/m0/rules-reference.json?ref=main
```

Compare against local `companion-rules-reference-publish-marker.json`:

| Marker field | Meaning |
|--------------|---------|
| `last_attempt_status` | `complete` or `failed` |
| `last_success_at_ms` | Last successful publish |
| `remote_content_revision_sha256` | Revision last known published |
| `local_content_revision_sha256` | Revision from local file at attempt |

On failed publish, marker stays `failed` and **does not** advance `remote_content_revision_sha256` or `last_success_at_ms`.

## API accounting

Each successful one-shot publish: **2** `gh api` invocations (content `GET` + `PUT`). Dry-run: **0**.

## Implementation map

- `lib/rules-reference-relay-publish.cjs` — validate, envelope, publish, marker, freshness
- `publish-rules-reference-once.cjs` — CLI
- `lib/github-relay.cjs` — `RELAY_CONTENT_PATHS.rulesReference`
- `test/rules-reference-relay-m1-wp5b.test.cjs` — isolated regression

Tactical relay files (`m0/state.json`, tactical command/result) are not modified by rules reference publish.
