# Security audit — 2026-09-20

Audit baseline: `307d0878ca4da7f11c412f96fa1beee11f9b6b0f` on `origin/main`.
Changes were developed in an isolated checkout. No production deployment, database migration, credential rotation, or PR merge was performed.

This is a source audit with local regression tests, not certification that every possible attack is impossible. HTTP registrations and Convex entrypoints were inventoried, common authorization boundaries were traced, and high-risk flows received deeper review. Generated/dependency behavior was inspected where needed. Production ingress, deployed secrets and roles, external provider configuration, and native desktop behavior on every operating system were not penetration-tested.

## Confirmed findings and remediation

| Issue | Severity / precondition | Fix |
| --- | --- | --- |
| [#710](https://github.com/wolvesdotink/owlat/issues/710) | Medium: streamed requests bypassed post-read body limits | Enforce byte limits while consuming request streams, including UTF-8 and multipart framing; cancel overflow without waiting on the producer. [PR #730](https://github.com/wolvesdotink/owlat/pull/730). |
| [#711](https://github.com/wolvesdotink/owlat/issues/711) | Medium: accepted auth callback origin | Preserve upstream redirects and cookies; do not fetch callback targets on the server. [PR #727](https://github.com/wolvesdotink/owlat/pull/727). |
| [#712](https://github.com/wolvesdotink/owlat/issues/712) | High: code running as sandbox UID | Remove credentials from Git argv; protect root-owned `.git` against replacement through its parent. [PR #724](https://github.com/wolvesdotink/owlat/pull/724). |
| [#713](https://github.com/wolvesdotink/owlat/issues/713) | High: sandbox process survives task completion/cancellation | Reap the dedicated sandbox UID through a same-UID helper; stop the worker if cleanup fails. [PR #724](https://github.com/wolvesdotink/owlat/pull/724). |
| [#715](https://github.com/wolvesdotink/owlat/issues/715) | Medium: malicious unsubscribe target and user confirmation | Apply DNS-aware guarded transport, including connect-time address checks and disabled redirects. [PR #730](https://github.com/wolvesdotink/owlat/pull/730). |
| [#716](https://github.com/wolvesdotink/owlat/issues/716) | High: unrelated authenticated member | Exclude private chat uploads from shared media/export/URL paths; prevent alias registration and private-file reuse; repair legacy classification. [PR #730](https://github.com/wolvesdotink/owlat/pull/730). |
| [#717](https://github.com/wolvesdotink/owlat/issues/717) | High: authenticated caller knows another resource's storage ID | Server-attested upload receipts bind blobs to user, organization, and resource; gate binding, transfer, and destructive cleanup. [PR #730](https://github.com/wolvesdotink/owlat/pull/730). |
| [#718](https://github.com/wolvesdotink/owlat/issues/718) | Low/moderate dependency advisories; reachability varies | Install compatible patched versions; preserve existing local image-size fixes. [PR #729](https://github.com/wolvesdotink/owlat/pull/729). No exploit is asserted for every dependency advisory. |
| [#719](https://github.com/wolvesdotink/owlat/issues/719) | High: member, pending higher-role invitation, legacy verification setting | Always verify invited email ownership before accepting membership; preserve legacy sign-in policy. [PR #728](https://github.com/wolvesdotink/owlat/pull/728). |
| [#720](https://github.com/wolvesdotink/owlat/issues/720) | Medium: exposed production instance before setup | Block first-account public signup outside explicit development mode; trusted seed endpoint remains available. [PR #728](https://github.com/wolvesdotink/owlat/pull/728). |

The worker metadata issue was found during fix review. Upload transport was revised after review identified Convex HTTP limits and Nuxt middleware buffering. Legacy deletion paths were revisited after the first ownership patch. These review findings are included in the corresponding fixes, rather than treated as separate completed work.

## Route and authorization coverage

[HTTP route inventory](http-routes.csv) contains 181 route/mount rows and records explicit registrations, router mounts, Nuxt file routes (including `.well-known`), updater conditional dispatch, the worker function proxy, and the BetterAuth mount. Router-local paths must be combined with their mounts; mount rows are not additional endpoints. BetterAuth's dependency-generated subroutes are represented by their mount and plugin policy, not expanded into a misleading static route count.

[Convex entrypoint inventory](convex-entrypoints.csv) contains 797 wrapper entries (including HTTP handler factories) and records application wrappers and recognized guard calls. It is a structural census, not a claim that every function body received an independent semantic proof. Empty guard-call cells can reflect delegated helpers or intentionally public metadata. Internal functions were also examined as part of sensitive caller-to-resource flows; they are not exposed through the ordinary public RPC API.

| Surface | Protection examined and boundary assumptions |
| --- | --- |
| REST `/api/v1/*` | Hashed API keys, revocation/expiry, explicit scopes, rate limiting, body limits, CORS, and resource validation. Health/preflight intentionally public. |
| Convex application RPC | Authentication wrappers, live organization membership/roles, permission gates, mailbox ownership, private room membership, assistant access, public-query opt-outs, and token redaction. Single organization per instance is an explicit product assumption. |
| BetterAuth and Nuxt proxy | Registration, invitations, email identity, origin checks, cookies, redirect handling, session-to-JWT exchange, fixed upstream origin, and forwarded IP handling. |
| Browser administration/setup | Organization/platform admin gates, instance/setup secrets, deployment state, CSRF middleware, fixed service targets, and updater validation. |
| Public tracking/forms/shares | Capability validation, expiry/resource state, intentionally anonymous content, form submission policy, CORS, and rate limits. Possession of a share/download capability grants its documented access. |
| Provider/channel/GitHub/MTA webhooks | Signature/shared-secret verification, bounded reads, provider challenge routes, dispatch, and internal mutation boundaries. |
| Storage and attachments | Upload provenance, one-use receipts, resource binding, private chat visibility, draft/archive/share deletion, legacy aliases, export access, and background cleanup. |
| MTA HTTP and SMTP | Send credentials and organization scope; master-key middleware on administrative routers; SMTP limits/authentication and tested parser boundaries. Health/metrics are operational metadata intended for the internal network. |
| Mail-sync | Worker key, account credential lookup, signed raw-message source, and trusted service boundary. |
| Updater | Instance-secret authentication on all seven routes, bounded requests, allowed profiles/options, command construction, and privileged Docker boundary. The instance secret is a high-trust credential. |
| Code worker / function proxy | Environment and UID separation, Git metadata, process cleanup, container capabilities, exact function allowlist, token comparison, body/path parsing, and blocked `/api/function`. |
| Web content / desktop | HTML sanitizers and `v-html` uses, email iframe restrictions, visualization iframe isolation and message-source checks, deep-link encoding, native command capabilities, SSH command construction, and local-only capability scope. Full native execution was outside this audit. |
| Cryptography / dependencies / repository | Existing seal/signature/token boundaries, key handling call sites, dependency advisories and local parser patches, static analysis, and secret-pattern scanning. No cryptographic primitive design proof is claimed. |

Existing parallel fixes were checked to avoid duplicate issues. In particular, [PR #708](https://github.com/wolvesdotink/owlat/pull/708) and [PR #701](https://github.com/wolvesdotink/owlat/pull/701) contain adjacent HTTP/sidecar work; this audit's baseline does not assume they are merged.

## Validation

- All 26 additionally tested workspaces passed: 8,107 tests in total, including mail, SMTP, proxy, updater, shared, rendering, and plugin packages.
- Full web suite: 608 files, 6,347 tests passed before adding the upload bridge; eight new bridge/config regressions were run separately and passed.
- Worker final run: 122 tests passed, including five real Docker tests with the shipped capability restrictions, read-only root filesystem, and no-new-privileges. TypeScript passed. A real sandbox edit followed by privileged Git add/commit also succeeded.
- Repository script suite: 19 files, 290 tests passed, including the image-size parser regressions.
- Full API run: 831 files passed, 3 failed; 11,204 tests passed and 8 failed while relevant files were being changed. The three failing files were subsequently rerun against the completed changes. All three files passed a fresh 50-test rerun; the complete run plus reruns exercised 834 files / 11,212 tests. The original run is not represented as an all-green run.
- API TypeScript and the complete backend lint/policy suite pass. Focused upload/server TypeScript and lint pass. A broad generated server-only TypeScript probe also pulled in unrelated app/test declarations and did not pass; it is not reported as a complete web typecheck. Repository formatting and file-size gates pass.
- Gitleaks 8.30.1: no leaks in the current tracked/new-source snapshot (27.65 MB). A full-history scan was stopped before completion; history is not claimed clean.
- Semgrep: 201 rules, 3,926 files, zero findings, approximately 99.9% parse coverage. Repository ignore rules skipped 3,274 paths. Manual review found the issues above despite this clean scan.
- Dependency audit after updates: only two high image-size advisories remain in package metadata; both have existing repository patches and passing parser regressions. The repository audit policy passes. The other reported low/moderate advisories were removed with compatible updates.

## Rollout and remaining limits

Deploy coordinated API and web changes for the upload bridge. `SITE_URL` must point to the web origin, and the existing `INSTANCE_SECRET` must be configured consistently in web and Convex. The bridge fails closed if configuration is missing. Native storage receives streamed bytes; Convex HTTP actions receive only small service-authenticated receipt messages. This preserves the supported large-file limits without buffering files in Convex HTTP actions. Convex documents the smaller HTTP-action upload limit in its [upload guide](https://docs.convex.dev/file-storage/upload-files#uploading-files-via-an-http-action).

Restrict ordinary traffic during deployment and run `migrations/0044_private_chat_media:run` before reopening access. The bounded, idempotent migration repairs chat tags removed by old library edits and classifies duplicate storage aliases. It conservatively privatizes shared assets that were posted in chat; upload a separate shared copy when needed. Maintenance documentation covers the procedure.

Previously disclosed download URLs and downloaded bytes cannot be recalled by metadata classification. Legacy references without reliable ownership receipts remain readable but do not authorize destructive deletion; this can leave old orphaned bytes requiring separately reviewed cleanup. Pending native uploads minted before the rollout must be retried with a new upload URL.

Worker process cleanup requires the shipped dedicated PID namespace, positive dedicated UID/GID, and one job at a time. Do not share that sandbox UID with unrelated tasks or enable host PID mode. Existing JWT sessions may remain cryptographically valid until their documented short expiry; live membership/role checks remain important.

No browser end-to-end run against a deployed Convex backend or live third-party provider was performed. Network isolation, reverse-proxy configuration, installed native binaries, and secret rotation still need validation in the actual deployment. Review comments on the PRs record the local evidence and constraints; they are not independent human approval.
