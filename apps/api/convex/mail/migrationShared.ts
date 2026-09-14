/**
 * Historical import for a SHARED TEAM INBOX — the mailbox-keyed twins of the
 * personal migration trio in `mail/migration.ts`.
 *
 * Why twins rather than a scope argument on the personal functions: every entry
 * point there resolves "the caller's live personal account" and stamps the
 * caller's onboarding checklist, so the wizard's contract (and its tests) stay
 * exactly as they were. What the two variants DO share is this file's imports —
 * `startMigrationForAccount` / `latestMigrationForAccount` /
 * `cancelMigrationForAccount` are the scope-agnostic core, so the idempotency
 * rule, the cursor reset, the audit entries and the progress projection can
 * never drift between a personal and a team import.
 *
 * They live in their own module because `migration.ts` sits at the ~500 LOC cap
 * (CONVENTIONS.md → "Split only above ~500 LOC"); the generated paths of the
 * personal functions are unchanged by the split.
 *
 * Differences from a personal migration, all of them consequences of a team
 * inbox being ORG INFRASTRUCTURE rather than one person's mailbox:
 *   - authorization is `requireSharedExternalAccount` (the mailbox `owner`
 *     floor, which also admits org owner/admin) instead of "it's yours";
 *   - NO onboarding step is ever stamped (`scope: 'shared'` on the row is what
 *     the completion paths in `migration.ts` / `migrationIndexing.ts` read);
 *   - knowledge indexing is OPT-IN (`indexKnowledge`), not on-by-default:
 *     indexing fans one LLM call per imported message into the org-wide
 *     knowledge graph, which for a team's mail history is a privacy and cost
 *     decision, and the writing-voice profile does not need it.
 *
 * The mail-sync worker needs no changes: it polls `getBackfillWork` by account
 * and has no notion of scope.
 */

import { v } from 'convex/values';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { assertFeatureEnabled, isFeatureEnabled } from '../lib/featureFlags';
import {
	migrationSourceValidator,
	startMigrationForAccount,
	latestMigrationForAccount,
	cancelMigrationForAccount,
} from './migration';
import { requireSharedExternalAccount, resolveSharedExternalAccount } from './external/sharedInbox';

/**
 * Begin importing a shared team inbox's existing mail. Idempotent: an import
 * that is still importing/indexing is returned as-is rather than duplicated.
 * The worker re-walks every discovered folder from its high-water mark on its
 * next pass; forward sync of NEW mail is untouched throughout.
 *
 * `indexKnowledge` opts the import into the contact-scoped knowledge graph and
 * is honoured only when the `ai.knowledge` feature is on — the default is off.
 */
// authz: requireSharedExternalAccount → requireMailboxAccess(owner) + shared-external gate.
export const startShared = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		source: v.optional(migrationSourceValidator),
		indexKnowledge: v.optional(v.boolean()),
	},
	handler: async (ctx, args, session) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const { mailbox, account } = await requireSharedExternalAccount(ctx, args.mailboxId);
		const isAiIndexingEnabled =
			args.indexKnowledge === true && (await isFeatureEnabled(ctx, 'ai.knowledge'));
		return await startMigrationForAccount(ctx, {
			account,
			mailboxId: mailbox._id,
			// The admin who started it — audit/custody only; a shared row's userId
			// never drives onboarding or any per-user surface.
			userId: session.userId,
			organizationId: mailbox.organizationId,
			source: args.source ?? 'imap',
			scope: 'shared',
			isAiIndexingEnabled,
		});
	},
});

/**
 * Progress of a shared team inbox's most recent import, or `null` when there is
 * none. Soft-fails to `null` for a caller without the owner floor on that
 * mailbox (or a mailbox that isn't an external team inbox), exactly like
 * `getSharedExternalAccount` — a member of another team gets "nothing here"
 * rather than an error that confirms the inbox exists.
 */
// authz: resolveSharedExternalAccount → requireMailboxAccess(owner) + shared-external gate (soft: null).
export const getStatusShared = authedQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		// Read-side degradation rather than a throw: the admin page renders this
		// alongside other cards and an instance with `mail.external` off simply has
		// no team inbox to report on.
		if (!(await isFeatureEnabled(ctx, 'mail.external'))) return null;
		const resolved = await resolveSharedExternalAccount(ctx, args.mailboxId);
		if (!resolved) return null;
		return await latestMigrationForAccount(ctx, resolved.account._id);
	},
});

/**
 * Cancel a shared team inbox's in-flight import. The worker's next
 * `getBackfillWork` poll reports inactive and the knowledge sweep exits at its
 * chunk boundary; mail imported so far (and anything indexed from it) is kept.
 * Returns whether there was something to cancel.
 */
// authz: requireSharedExternalAccount → requireMailboxAccess(owner) + shared-external gate.
export const cancelShared = authedMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const { account } = await requireSharedExternalAccount(ctx, args.mailboxId);
		return await cancelMigrationForAccount(ctx, account);
	},
});
