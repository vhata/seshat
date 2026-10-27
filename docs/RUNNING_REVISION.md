# Running revision

`GET /api/health` reports the schema and the identity of the Worker serving
that request. It is public, uses `Cache-Control: no-store`, and returns only:

```json
{
  "ok": true,
  "schemaVersion": 4,
  "build": { "commit": "0123456789012345678901234567890123456789", "dirty": false },
  "version": { "id": "11111111-1111-4111-8111-111111111111" }
}
```

The schema number above is illustrative. The commit is embedded in the
Worker during Vite's build; the version ID comes from Cloudflare's
[version metadata binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/).
The response does not expose configuration, arbitrary tags, annotation
messages, credentials, account identity or repository/PR data.

A dirty build's commit identifies its base, not the exact built source.
Normal `npm run build` permits this for development and validation, marks
it `dirty: true`, and writes the same identity to
`dist/seshat/revision.json`. Without Git, or during local development and
Worker tests, both build fields are `null`. Missing or local placeholder
version metadata produces `version.id: null`. These cases cannot verify
a hosted release. The package version and a later local checkout say
nothing about the running build.

## Build and tag an upload

Deployment still needs explicit owner authorization each time under
[the workflow contract](../docket/CONTRACT.md). These commands do not grant
that authorization. Run the full checks, commit the intended source, and
build from that clean checkout:

```sh
bash scripts/check.sh
npm run build:release
```

`build:release` refuses dirty or unidentified source. The generated
Worker contains the captured commit; the adjacent manifest records it
for tagging. After confirming the target account and Worker and obtaining
deployment authorization, upload that artifact:

```sh
npx wrangler deploy --config dist/seshat/wrangler.json \
  --tag "$(node -p "require('./dist/seshat/revision.json').commit")"
```

The tag is read from the built artifact, not from the current checkout.
Do not edit the generated manifest or configuration. Rebuild after source
changes; tagging an existing artifact with a new checkout's commit would
misidentify it. This is a source identification mechanism, not a signed
attestation or an automated deployment procedure.

## Inspect the active deployment

With Wrangler authenticated to the intended Cloudflare account:

```sh
npm run inspect:revision -- https://YOUR-INSTANCE --name seshat
```

This command only reads. It obtains Cloudflare's active deployment, requests
the instance's health endpoint, and checks that the serving version has
positive traffic in that deployment. It inspects that exact version and
checks the deployment again to detect a change during inspection. Its
JSON output contains only approved identity fields; raw version responses
can include configuration and must not be published.

Inspection refuses unknown or dirty builds, inactive or mismatched version
IDs, a deployment change, and any present tag that is not the embedded
full Git commit. A missing tag is reported explicitly: secret updates can
create new versions without preserving annotations, while retaining the
embedded build identity. The inspector never substitutes local Git state
or the latest uploaded version for the version actually serving traffic.

For a gradual deployment, one health request samples one active version;
the output lists the active version IDs and traffic percentages rather
than claiming all traffic runs the sampled commit. Repeat inspection after
each authorized deployment, secret update or rollback. A rollback creates
a new deployment referring to an older version, so its ID and embedded
commit must be those of that older version. See Cloudflare's
[rollback limits](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/),
including Durable Object migration restrictions; identifying a version
does not establish data/schema rollback safety.

The equivalent read-only Wrangler commands are:

```sh
npx wrangler deployments status --name seshat --json
npx wrangler versions view VERSION_ID --name seshat --json
```

## Verification boundary

Automated tests use synthetic Git repositories, Worker runtime bindings
and Cloudflare responses. They cover changed source, dirty and unknown
builds, rollback identities, split traffic, tag mismatch, deployment races
and safe output. They do not establish what is deployed to a real account.

Hosted acceptance requires an authorized deployment, successful inspection
against that account's active deployment, and repeated inspection after a
later authorized deployment or rollback. A pre-feature deployment without
identity fields cannot pass inspection. Record hosted evidence separately
from the local checks, without credentials or private instance data.

## Hosted verification, 2026-10-26

Two explicitly authorized uploads of the same artifact to
<https://seshat.vhata.workers.dev> demonstrated the identity check across a
later deployment. Both used clean source commit
`e3ba7a20ad0048073c5d06d62922fe7b78c444bc` and that full commit as the
Cloudflare version tag. The Worker bundle's SHA-256 was
`91e2dc3d081f46c47f109bb47298f84c40486b9a9148bb693c8be9d9caf0af49`;
all nine build artifact files had unchanged hashes across the uploads.
These records identify the source actually uploaded, independently of a
later checkout or squash commit.

| Upload | Observed at (UTC, 2026-10-27) | Active deployment ID | Serving version ID | Traffic |
| --- | --- | --- | --- | --- |
| First | 01:54:58 | `556f95a1-3038-4d6c-9af7-fcf5c9ac699e` | `f79af5b1-8b35-4237-b1b3-c26edb245869` | 100% |
| Second | 01:55:57 | `e68e5d62-e8b1-4315-8eb5-17e21eea3db8` | `ef8807a3-cbfe-4051-a217-9d1ab5e27bd9` | 100% |

After each upload, the inspector returned `verified: true`: the responding
version belonged to the stable active deployment, exact-version metadata
matched that ID, and the embedded commit and version tag matched the
artifact. The second inspection observed different deployment and version
IDs while retaining the same source identity. Exact version metadata for
both uploads and the second live inspection were independently checked.

Before these uploads, the existing deployment reported schema 3 without
identity fields. The first upload briefly returned the new Worker identity
alongside schema 3 before the Durable Object advanced to schema 4. Acceptance
was recorded only after schema 4 was observed. A source identity match alone
therefore does not establish that object/schema propagation has completed.

Both settled deployments returned healthy schema 4 and refused anonymous
session, overview and socket requests with HTTP 401. Configured setup
returned HTTP 404, the public frontend returned HTTP 200, and checked API
and setup responses used `Cache-Control: no-store`. Only approved identity
fields appeared in health. No credentials or private repository/PR content
are part of this record.

This demonstrates source and serving-version identification across two
deployments of one artifact. It does not demonstrate two different source
revisions, a live rollback, secret-derived version annotations, split
traffic, authenticated sign-in/socket recovery, GitHub freshness, data
recovery or operation on a Free subscription. Synthetic tests cover the
inspector's rollback and split-traffic cases. No new service was provisioned.
