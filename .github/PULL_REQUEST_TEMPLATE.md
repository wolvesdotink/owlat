<!--
Title: a conventional commit title in plain language, for example
"fix(web): the reader keeps its scroll position after a reply".
Types and scopes are listed in CONTRIBUTING.md under "Commit Messages".
-->

## Problem

<!-- The problem in a sentence or two: what goes wrong or what is missing, and
for whom. Link the issue if there is one. -->

## Change

<!-- How this fixes it, and why it is shaped this way. If it spans several
apps or packages, say why each part is needed for the same fix. -->

## Surfaces touched

<!-- Walk the "Hit every surface" list in CLAUDE.md and name the entries that
applied, with what you did for each: entry points (page, palette, shortcut,
settings), web and desktop, Convex (auth floor, feature gate, migration,
crons), services, en/de copy and docs, self-hosting env and setup-cli, kits
and SDKs, personal and team mailboxes, AI agent tools, reverse states.
"None beyond the one page" is a valid answer when it is true. -->

## Verification

<!-- What you ran, what you saw, and what you couldn't check.

- Commands and their results, e.g. "apps/api: npx vitest run
  convex/__tests__/foo.test.ts, 12 passed" or "bun run ci:lint, exit 0".
  "Tests pass" alone is not enough.
- For a logic, data, state or protocol bug: the test that failed before the
  fix (see "Verifying" in CLAUDE.md).
- For a UI change: before/after screenshots of the same page, viewport and
  theme. Add a short video when motion or timing matters. Upload them here;
  never commit them.
- What you could not check, and why (no local backend, no desktop build on
  this OS, a secret only CI has). -->

## Scope

<!-- Optional: what this deliberately leaves out, and any follow-up issues. -->

## UX checklist

- [ ] Surfaces lead with a verdict/summary; detail is one interaction away
      (see [`docs/design/progressive-disclosure.md`](../docs/design/progressive-disclosure.md)).

## Security checklist

Skim before requesting review. Tick each item or strike it through with a
reason. Most PRs will only touch one or two.

- [ ] **Convex auth**: every new `query` / `mutation` / `action` uses a
      builder from `apps/api/convex/lib/authedFunctions.ts` (`authedQuery`,
      `adminMutation`, `featureGated`, …). A `publicQuery` /
      `publicMutation` / `publicAction` carries a `// public: <reason>`
      comment (see `apps/api/convex/CONVENTIONS.md`).
- [ ] **No caller-supplied userId**: any `userId` in `args` is gated by an
      admin role check.
- [ ] **Webhooks**: new HTTP action validates its signature/secret with
      `constantTimeEqual` and returns 503 if the env var is unset.
- [ ] **Redirects**: any `route.query.redirect` / `redirectTo` value goes
      through `safeRedirect()`.
- [ ] **Open-redirect**: any new `<a href>` / `navigateTo` of a
      caller-supplied value is filtered.
- [ ] **HTML rendering**: untrusted HTML is sanitized via the right
      sanitizer for the boundary (`sanitizeRawHtml`,
      `POSTBOX_SANITIZE_CONFIG`, or signature path). No new regex-based
      strippers.
- [ ] **External fetch**: URL host is hard-coded or shape-validated; no
      user input pasted into the host portion.
- [ ] **Secrets**: new env vars are documented in `.env.selfhost.example`
      and `SECURITY.md`. No secrets logged.
- [ ] **CSP / headers**: nothing forces a new `'unsafe-*'` directive.

See `SECURITY.md` for what each item is guarding against.
