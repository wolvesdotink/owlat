<!-- One-line summary in the title; details below. -->

## What & why

<!-- Short context: what does this change, and why does it need to happen? -->

## Test plan

- [ ] Unit / integration tests (`bun run ci:test`)
- [ ] Manual verification — what did you click through?

## UX checklist

- [ ] Surfaces lead with a verdict/summary; detail is one interaction away
      (see [`docs/design/progressive-disclosure.md`](../docs/design/progressive-disclosure.md)).

## Security checklist

Skim before requesting review. Tick each item or strike it through with a
reason. Most PRs will only touch one or two.

- [ ] **Convex auth**: new `mutation` / `query` calls
      `getMutationContext` / `getUserIdFromSession` (or has a `// PUBLIC` marker
      with a justification).
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
