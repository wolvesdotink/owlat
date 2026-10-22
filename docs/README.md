# Owlat docs

Where each kind of documentation lives. The rules for what goes where, and for
what stays out of the repository, are in
[CLAUDE.md, "Documentation"](../CLAUDE.md#documentation). Most code changes need
no documentation change.

## Using and running Owlat

The docs site is the Nuxt Content app under
[`apps/docs/content/`](../apps/docs/content/), in English (`en`) and German
(`de`), published at [docs.owlat.app](https://docs.owlat.app/).

- `1.guide`: user guides, one per feature
- `2.api`: the public HTTP API, the SDKs and webhooks
- `3.developer`: architecture, self-hosting, configuration and the plugin
  platform
- `4.examples`: worked integrations
- `5.vision`: where the product is heading

## Working on Owlat

- [CONTRIBUTING.md](../CONTRIBUTING.md): setup, testing, commit messages, PR
  descriptions and the CI checks
- [CLAUDE.md](../CLAUDE.md): working rules for people and agents, including the
  proof each kind of change needs and the "Hit every surface" checklist
- [SECURITY.md](../SECURITY.md): trust boundaries, the checks a new function,
  webhook, upload or rendered HTML needs, and how to report a vulnerability

### Runbooks

- [Development](./operations/development.md): a local stack per checkout, its
  ports and data, and how to stop it
- [Observability](./operations/observability.md): where logs and metrics are,
  and how to follow one send
- [Releasing](./RELEASING.md): cutting a release and the manual steps it needs
- [Sealed Mail manual QA](../scripts/sealed-mail-qa.md): the two-instance check
  that CI cannot run

### Rules and constraints

Internal notes keep decisions, constraints that cross modules, and traps the
source does not show.

- [Glossary](../CONTEXT.md): the project's vocabulary
- [Convex conventions](../apps/api/convex/CONVENTIONS.md): file layout, naming
  and permission rules for the backend
- [Abstractions](./abstractions.md): the provider and adapter interfaces that
  keep external services swappable
- [Progressive disclosure](./design/progressive-disclosure.md): how much detail
  a UI surface shows at once
- [Audit log actions](../apps/api/convex/docs/audit-log-actions.md) and
  [webhook payloads](../apps/api/convex/docs/webhook-payloads.md): contracts
  that stored rows and external receivers depend on
- [Quality ratchets](../scripts/quality-ratchets.md): the lint warning baseline
  and the coverage floors
- Design tokens live in code, in
  [`packages/ui/assets/css/tokens.css`](../packages/ui/assets/css/tokens.css).

### Packages

The kits and SDKs document themselves in their READMEs:
[plugin-kit](../packages/plugin-kit/README.md),
[provider-kit](../packages/provider-kit/README.md),
[plugin-cli](../packages/plugin-cli/README.md),
[sdk-js](../packages/sdk-js/README.md) and
[sdk-java](../packages/sdk-java/README.md).

## Security audits

- [2026-09-20](./security/2026-09-20/README.md): source audit, its findings and
  the PRs that fixed them
