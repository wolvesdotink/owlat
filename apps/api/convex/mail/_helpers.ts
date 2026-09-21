/**
 * Feature-gated function builders for the Postbox (personal mail) module.
 *
 * They compose the org-member auth floor (`authedQuery` / `authedMutation`)
 * with an any-of feature floor, so a handler in `mail/**` can no longer run
 * when the instance has neither personal-mail capability enabled. Per-mailbox
 * and per-message authz (`requireMailboxAccess` / `requireMessageAccess`) and
 * the org-role gates still live in the handler — the floor here decides only
 * whether the surface exists on this instance.
 *
 * ANY-of, not all-of: the Postbox UI is reachable through hosted mailboxes
 * (`postbox`) or through a connected external mailbox (`mail.external`), and
 * `mail.external` deliberately does not depend on `postbox` — that would force
 * the hosted ACME + IMAP-server stack on the user who is avoiding it. The web
 * route gates on exactly the same pair (`/dashboard/postbox` declares
 * `requiresAnyFeature: ['postbox', 'mail.external']`), so the two now agree
 * rather than the route guard being the only check.
 *
 * NOT for every file under `mail/`:
 *   - modules that already assert the stricter `mail.external` on their own
 *     (mailbox move, external accounts, the migration family) keep that gate —
 *     any-of would widen it.
 *   - modules that serve another surface keep theirs: the shared team inbox
 *     (`inbox`), the AI handling rules (`ai.autonomy`), invitation acceptance
 *     and the team roster (reachable before any mail flag is on).
 *   - `internal*` functions are untouched. IMAP, the mail-sync worker and the
 *     delivery pipeline call them with no user session, and an instance that
 *     turned a flag off must still be able to finish draining what it has.
 *
 * Not exported as Convex functions (the leading underscore keeps this module
 * off the public API surface); only imported by sibling `mail/**` modules.
 */

import { authedQuery, authedMutation, featureGatedAny } from '../lib/authedFunctions';

/** The pair of flags that make the personal-mail surface exist on an instance. */
export const POSTBOX_FEATURE_FLAGS = ['postbox', 'mail.external'] as const;

export const postboxQuery = featureGatedAny(authedQuery, POSTBOX_FEATURE_FLAGS);
export const postboxMutation = featureGatedAny(authedMutation, POSTBOX_FEATURE_FLAGS);
