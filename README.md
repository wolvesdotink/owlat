<p align="center">
  <img src="./apps/marketing/public/logo.svg" alt="Owlat" width="120" />
</p>

# Owlat

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Docs](https://img.shields.io/badge/docs-owlat.app-orange)](https://docs.owlat.app)
[![Made by Wolves](https://img.shields.io/badge/made_by-wolves.ink-6d28d9)](https://wolves.ink)

Self-hosted, modular email platform. Run marketing campaigns, a personal mailbox, a team inbox, or any combination — turn features on and off through a single feature-flag system. Own your data, own your domain, no per-contact pricing.

> **Open-source (Apache 2.0) · Free to self-host · Use anywhere, no restrictions** ([Apache 2.0](./LICENSE))

Hosted cloud is on the roadmap — [join the waitlist](https://owlat.app/waitlist). Until then, every Owlat install is self-hosted.

## Quick install

On a fresh Linux VPS with Docker + Docker Compose v2:

```sh
curl -fsSL https://get.owlat.app | bash
```

The one-liner installs the `owlat` CLI to `/usr/local/bin` and runs `owlat quickstart`: it asks for your domain, DNS, DKIM, SMTP settings, and which feature packs you want enabled, then generates secrets, brings up the Docker stack, deploys the Convex functions, pushes the runtime env vars, and bootstraps your admin account. 10 minutes from empty VPS to working install.

Already have a clone? `git clone https://github.com/wolvesdotink/owlat.git && cd owlat && scripts/owlat quickstart` runs the exact same blessed flow. The older pure-bash wizard (`bash scripts/setup.sh`) still ships as a legacy fallback — prefer `owlat quickstart` for new installs.

See [docs/developer/self-hosting](https://docs.owlat.app/developer/self-hosting) for the detailed guide.

## Local development

For working on Owlat itself (cloned repo, Docker available, no real DNS or email infra needed):

```sh
git clone https://github.com/wolvesdotink/owlat.git
cd owlat
bun install
bun run setup    # interactive: wizard + docker up + bootstrap admin + seed demo data
```

`bun run setup` walks through a small wizard and then asks one decision:

- **Populated** *(default)* — creates an admin user and seeds realistic demo data (15 contacts across 3 topics, 3 email templates, a sent campaign with stats, an active automation, one verified sending domain). Best for working on existing features.
- **Blank** — brings up the stack with no admin, no data. Visit `http://localhost:3000` and the app redirects to `/auth/register` so you can exercise the real signup flow end-to-end. Use `bunx owlat-setup reset` to wipe back to blank between attempts.

When working on the UI (`bun run dev`, which runs `nuxt dev`), the dashboard exposes a few admin shortcuts marked with a yellow **DEV** badge — currently a "Force Verify" button on the domains settings page that flips a domain to `verified` without running real DNS lookups. They're tree-shaken out of any `nuxt build` bundle (selfhost or hosted) via `import.meta.env.DEV`, and the backend additionally requires `OWLAT_DEV_MODE` to be set on the Convex deployment (`npx convex env set OWLAT_DEV_MODE true`). Production deployments leave it unset and the dev endpoints (`/seed/demo`, `/dev/reset`, Force Verify) fail-closed with a 403.

The lower-level path (`bash scripts/setup.sh`) is still available for headless VPS provisioning. `bun run setup` is the path to take when you have a clone in front of you.

### Resource requirements

|  | Minimum | Recommended |
|---|---|---|
| RAM | 4 GB | 8 GB |
| Disk | 20 GB | 40 GB |
| CPU | 2 vCPU | 4 vCPU |
| Domain + DNS | Required | Required |

## Features

Owlat is built as a set of independent feature areas. Each one can be turned on or off in the admin UI or with `owlat-setup feature <key> <on|off>`. The setup wizard groups related flags into "packs" so you can enable a whole product surface in one click.

### Sending — outbound mail

| Feature | Flag | Default | Description |
|---|---|---|---|
| Marketing campaigns | `campaigns` | on | Broadcast sends with segments, scheduling, A/B testing |
| Public archive links | `campaigns.archive` | on | "View in browser" links for every campaign |
| Transactional API | `transactional` | on | Programmatic sends (receipts, password resets) via the API |
| Automations | `automations` | off | Trigger-based multi-step workflows (welcome series, drip) |

### Receiving — inbound mail

| Feature | Flag | Default | Description |
|---|---|---|---|
| Email inbox | `inbox` | off | Shared team inbox with threading and a triage queue |
| Personal mail (Postbox) | `postbox` | off | Per-user mailboxes with webmail UI and native IMAP/SMTP |
| Code task extraction | `inbox.codeTasks` | off | Detect bug reports in inbound mail and surface as tasks |
| Chat | `chat` | off | Real-time chat surface alongside the inbox |

### AI

| Feature | Flag | Default | Description |
|---|---|---|---|
| Master AI toggle | `ai` | off | Required by every AI feature. Needs an LLM provider configured |
| AI agent | `ai.agent` | off | Auto-classify inbound mail and draft suggested replies |
| Autonomous actions | `ai.autonomy` | off | Let the agent send approved replies without human review |
| Knowledge graph | `ai.knowledge` | off | Semantic extraction from conversations for agent context |
| AI dashboards | `ai.visualizations` | off | Generate charts from natural-language prompts |

### Integrations

| Feature | Flag | Default | Description |
|---|---|---|---|
| Outbound webhooks | `webhooks` | off | Deliver event payloads to external HTTP endpoints |
| Embeddable forms | `forms` | on | Signup/capture forms for external sites |
| Mailchimp import | `imports.mailchimp` | off | One-click contact and list import |
| Stripe customer sync | `imports.stripe` | off | Sync Stripe customers into contacts (email, name, and their Stripe metadata as properties) |

### Security & deliverability

| Feature | Flag | Default | Description |
|---|---|---|---|
| Content scanning | `scan.content` | on | Block obvious spam, phishing, and homoglyph attacks |
| File scanning (ClamAV) | `scan.files` | on | Antivirus on attachments via ClamAV sidecar |
| URL reputation | `scan.urls` | off | Google Safe Browsing checks on outbound links |
| Domain verification | `domains.verification` | on | Validate SPF, DKIM, DMARC before allowing a domain to send |
| DKIM auto-rotation | `domains.dkimRotation` | on | Flag keys due for rotation; auto-activate an operator-published new key after the DNS overlap |
| PostHog analytics | `analytics.posthog` | off | Pipe product events to a PostHog instance |

### Built-in across every install

These are infrastructure, not flags — every install has them: a block-based email builder (Notion-style, 17+ block types, custom HTML rendering engine — not MJML), a media library, contact and topic management with double opt-in, audit logs, team permissions, API keys, dark mode, and pluggable provider abstractions for LLMs and email delivery.

For a full feature reference see the [guide](https://docs.owlat.app/guide) and the [feature-flags developer doc](https://docs.owlat.app/developer/feature-flags).

## Tech Stack

- **Frontend**: Nuxt 4 / Vue 3 / Tailwind CSS 4
- **Backend**: Convex (self-hosted, real-time)
- **Auth**: BetterAuth with organization plugin
- **Outbound MTA**: Built-in Node.js SMTP sender (custom; pluggable with Resend / SES)
- **Inbound IMAP**: Custom IMAP4rev1 server backed by Convex (Postbox feature only)
- **Package Manager**: Bun

## Monorepo Structure

```
owlat/
├── apps/
│   ├── web/              # Nuxt 4 dashboard
│   ├── api/              # Convex backend
│   ├── mta/              # Outbound Mail Transfer Agent (SMTP sender + scan endpoint)
│   ├── imap/             # IMAP4rev1 server for Postbox (personal mail)
│   ├── mail-sync/        # Syncs users' external IMAP/SMTP accounts ↔ Convex
│   ├── setup-cli/        # `owlat-setup` — wizard + feature/pack/env management
│   ├── updater/          # In-place update sidecar
│   ├── docs/             # Documentation site (Nuxt Content)
│   ├── marketing/        # Landing / marketing site
│   ├── desktop/          # Desktop client shell (experimental)
│   └── code-worker/      # Code-task worker (for `inbox.codeTasks`)
├── packages/
│   ├── email-builder/    # Block-based email editor (Vue)
│   ├── email-renderer/   # HTML rendering engine
│   ├── email-scanner/    # Content/URL/file security scanning + ClamAV
│   ├── email-previewer/  # Email client preview / compatibility analysis
│   ├── channels/         # Notification channel abstractions
│   ├── shared/           # Shared types, validation, feature flag registry
│   ├── ui/               # Reusable UI component library (Nuxt layer)
│   ├── sdk-js/           # JavaScript SDK
│   └── sdk-java/         # Java SDK
├── infra/templates/      # Docker Compose, Caddy, and .env templates
├── docker-compose.yml    # Base stack (web, api, mta, redis, updater)
└── scripts/              # setup.sh, backup.sh, restore.sh, owlat CLI
```

Self-hosters run `docker compose up -d`, which brings up the base stack (`web`, `api`, `mta`, `redis`, `updater`). Optional services are gated by Docker Compose profiles that are activated automatically when you enable the corresponding feature flag:

| Flag | Profile | Service |
|---|---|---|
| `scan.files` | `clamav` | ClamAV antivirus daemon |
| `inbox.codeTasks` | `inbox-codetasks` | AI code-task worker |
| `ai` | `ai` | Ollama (optional local LLM) |
| `postbox` | `personal-mail` | IMAP server |
| `mail.external` | `external-mail` | External-mailbox sync worker |

Automations, outbound webhooks, and the AI pipeline run inside the
Convex backend itself — they need no extra service or profile.

The hosted-cloud control plane (Stripe billing, multi-tenancy, VPS auto-provisioning) lives in a separate private repo and is not part of this codebase.

## Development

### Prerequisites

- Bun
- Node.js 22+
- Docker + Docker Compose v2

### Setup

```bash
git clone https://github.com/wolvesdotink/owlat.git
cd owlat
bun install
cp .env.example .env   # for local dev against hosted Convex
# — or, full self-host stack (generates secrets, deploys backend functions,
# pushes the Convex runtime env vars, creates the admin account — plain
# `docker compose up` alone boots an empty backend with no functions, no
# runtime env vars, and no way to log in):
scripts/owlat quickstart      # the blessed flow (legacy bash fallback: bash scripts/setup.sh)
# Doing it entirely by hand? `cp .env.selfhost.example .env && docker compose
# up -d` is NOT a working instance on its own — you must also mint the admin
# key, deploy functions, AND `convex env set` the runtime secrets
# (BETTER_AUTH_SECRET, SITE_URL, UNSUBSCRIBE_SECRET, EMAIL_PROVIDER,
# MTA_API_URL, …). See the full Option B sequence in
# docs/developer/self-hosting.
```

### Commands

```bash
bun run dev           # web + api in parallel (localhost:3000)
bun run dev:web       # Nuxt frontend only
bun run dev:api       # Convex backend only
bun run dev:docs      # docs site
bun run dev:marketing # marketing site
bun run build         # Production build (all apps)
bun run typecheck     # Turbo typecheck
bun run lint          # Oxlint
bun run lint:fix      # Oxlint + auto-fix
bun run ox:fmt        # Oxfmt
bun run ci:test       # Run all tests (vitest, NOT bun test)
```

Tests use **vitest** — `cd apps/api && npx vitest run`. Do **not** use `bun test` (it skips the vitest setup file that polyfills Nuxt auto-imports).

## API

`/api/v1/*` endpoints require an API key via `Authorization: Bearer <key>` (scoped keys — get one at **Settings → API Keys**):

| Endpoint | Description |
|---|---|
| `GET/POST /api/v1/contacts`, `GET/PUT/DELETE /api/v1/contacts/:id` | Manage contacts |
| `POST /api/v1/events` | Track custom events |
| `POST /api/v1/transactional` | Send transactional emails (template slug in the body) |
| `/api/v1/topics/*` | Manage topics + subscriptions |
| `GET /api/v1/health` | Health probe |

Token-authenticated public endpoints (no API key — used by recipients):
`POST /forms/:formId` (form submissions), `GET /archive/:token` (campaign
archive), unsubscribe/preference links.

Full reference: [docs.owlat.app](https://docs.owlat.app).

## Updates

Once installed, Owlat updates itself. Platform admins see a notification in **Settings → System & Updates** when a new version is available and can apply it with one click. Under the hood, the in-app update fetches the pinned `docker-compose-<version>.yml` for that release, writes it to disk, pulls the new images from GHCR, and redeploys the stack.

CLI equivalent: `owlat upgrade`.

## Community

- [Website](https://owlat.app)
- [Documentation](https://docs.owlat.app)
- [GitHub Issues](https://github.com/wolvesdotink/owlat/issues)
- [GitHub Discussions](https://github.com/wolvesdotink/owlat/discussions)

## License

[Apache 2.0](./LICENSE) — Use, modify, distribute, and sell freely; includes an express patent grant. Keep the license and copyright notices.
