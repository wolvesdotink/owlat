/**
 * Post-import "switch your sending" (outbound-only, gated).
 *
 * After an import a connected external mailbox keeps sending through the user's
 * own SMTP (`outboundPreference: 'external'`). Once their from-domain is a
 * VERIFIED sending domain on THIS instance AND the hosted Postbox outbound
 * transport (the MTA) is configured, they can flip to `'instance'` so mail ships
 * from Owlat's reputation instead — reversible any time from Postbox → Sending.
 *
 * The gate deliberately checks `getMtaConfig()`, not the broader
 * `isDeliveryConfigured`: the hosted Postbox dispatch path (`mail/outbound.ts`)
 * only sends via the MTA today, so offering the switch on an SES/SMTP-relay-only
 * instance would silently drop every message. We NEVER offer the switch for an
 * unverified domain (no spoofing gmail.com) — the from-domain being verified
 * asserts the MTA/SES identity exists so DKIM aligns.
 *
 *   Public: sendingSwitchStatus (prompt + settings state), setSendingPreference
 */

import { v } from 'convex/values';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { markOnboardingStep } from '../auth/userOnboarding';
import { checkEmailDomainVerification } from '../domains/domains';
import { getMtaConfig } from './mtaClient';
import { getLivePersonalExternalAccountForUser } from './externalAccounts';
import { throwInvalidInput, throwInvalidState, throwNotFound } from '../_utils/errors';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

type SessionWithRole = NonNullable<Awaited<ReturnType<typeof getBetterAuthSessionWithRole>>>;

/**
 * Resolve the caller's own active PERSONAL external mailbox (their live personal
 * account → its mailbox → active check). Returns `null` when the caller is
 * anonymous/role-less, has no live personal external account, or the mailbox
 * isn't active — letting each caller pick its own failure mode (the query
 * returns `{ configured: false }`, the mutation throws not-found).
 *
 * Resolves via `getLivePersonalExternalAccountForUser`, NOT a bare `by_user` +
 * `.first()`: sending is a PERSONAL surface, so a `scope='shared'` team-inbox
 * account the caller connected must never be resolved here (it would render the
 * team inbox in the personal Postbox → Sending section and let the caller flip
 * the team inbox's outbound transport), and a post-move `disconnected` archive
 * must never mask the caller's live personal mailbox.
 */
async function getCallerActiveExternalMailbox(ctx: QueryCtx | MutationCtx): Promise<{
	session: SessionWithRole;
	account: Doc<'externalMailAccounts'>;
	mailbox: Doc<'mailboxes'>;
} | null> {
	const s = await getBetterAuthSessionWithRole(ctx);
	if (!s || !s.role) return null;
	const account = await getLivePersonalExternalAccountForUser(ctx, s.userId);
	if (!account) return null;
	const mailbox = await ctx.db.get(account.mailboxId);
	if (!mailbox || mailbox.status !== 'active') return null;
	return { session: s, account, mailbox };
}

/**
 * Prompt + settings state for the caller's own external mailbox's outbound
 * transport. `promptEligible` is true ONLY when every gate holds — import +
 * knowledge indexing complete, the from-domain is a VERIFIED sending domain here
 * (so DKIM aligns), and the hosted Postbox transport (MTA) is configured — and
 * the mailbox is still on its own SMTP. The Postbox → Sending section reuses this
 * to render the reversible toggle even after the prompt is gone.
 */
// public: soft-auth — returns { configured:false } for anonymous or hosted-only users.
export const sendingSwitchStatus = publicQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const resolved = await getCallerActiveExternalMailbox(ctx);
		if (!resolved) return { configured: false as const };
		const { session, mailbox } = resolved;

		const preference = mailbox.outboundPreference ?? 'external';
		const [domainCheck, onboarding] = await Promise.all([
			checkEmailDomainVerification(ctx, mailbox.address),
			ctx.db
				.query('userOnboarding')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', session.userId))
				.first(),
		]);
		const domainVerified = domainCheck.verified;
		// The hosted Postbox path only dispatches via the MTA (mail/outbound.ts);
		// gate on that exact capability so we never route a switched mailbox onto a
		// transport that silently drops its mail.
		const transportConfigured = getMtaConfig() !== null;
		// "import + knowledge indexing complete" — both stamps present.
		const importAndIndexingDone =
			!!onboarding && onboarding.importDone != null && onboarding.knowledgeIndexed != null;

		const promptEligible =
			preference === 'external' && importAndIndexingDone && domainVerified && transportConfigured;

		return {
			configured: true as const,
			mailboxId: mailbox._id,
			address: mailbox.address,
			domain: domainCheck.domain || mailbox.domain,
			preference,
			domainVerified,
			transportConfigured,
			promptEligible,
		};
	},
});

/**
 * Flip the caller's external mailbox between sending through their own SMTP
 * (`'external'`) and this deployment's transport (`'instance'`). Reversible any
 * time from Postbox → Sending. Switching TO `'instance'` is hard-gated: the
 * from-domain must be a verified sending domain on this instance (asserting the
 * MTA/SES identity exists so DKIM aligns) AND the hosted MTA transport must be
 * configured. We refuse an unverified domain outright. The switch to instance
 * completes the `sendingSwitched` onboarding step; reverting leaves it (the
 * decision was made).
 */
// authz: self — operates on the caller's own external mailbox (by_user on s.userId).
export const setSendingPreference = authedMutation({
	args: { preference: v.union(v.literal('external'), v.literal('instance')) },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const resolved = await getCallerActiveExternalMailbox(ctx);
		if (!resolved) throwNotFound('External mail account');
		const { session, mailbox } = resolved;

		if (args.preference === 'instance') {
			// Gate 1 — verified from-domain. Never let mail ship from an identity
			// the instance can't DKIM-sign; this also blocks spoofing a domain we
			// don't control (e.g. gmail.com).
			const domainCheck = await checkEmailDomainVerification(ctx, mailbox.address);
			if (!domainCheck.verified) {
				throwInvalidInput(
					`Can't send "${mailbox.address}" from this instance yet — the domain "${domainCheck.domain || mailbox.domain}" isn't a verified sending domain here. Verify it under Settings → Domains first.`
				);
			}
			// Gate 2 — the hosted Postbox transport (MTA) actually exists to send
			// through. `isDeliveryConfigured` would be true for an SES/SMTP-only
			// instance, but that path can't dispatch hosted Postbox mail.
			if (getMtaConfig() === null) {
				throwInvalidState(
					"This instance has no outbound transport configured yet, so it can't send on your behalf. Set one up under Delivery first."
				);
			}
		}

		if ((mailbox.outboundPreference ?? 'external') === args.preference) {
			return { ok: true as const, preference: args.preference };
		}

		const now = Date.now();
		await ctx.db.patch(mailbox._id, { outboundPreference: args.preference, updatedAt: now });
		await ctx.db.insert('mailAuditLog', {
			mailboxId: mailbox._id,
			event:
				args.preference === 'instance'
					? 'sending.switched_to_instance'
					: 'sending.switched_to_external',
			occurredAt: now,
		});
		if (args.preference === 'instance') {
			await markOnboardingStep(ctx, session.userId, 'sendingSwitched');
		}
		return { ok: true as const, preference: args.preference };
	},
});
