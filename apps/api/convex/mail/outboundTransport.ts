/**
 * Outbound transport resolution for a mailbox — the single source of truth for
 * "where does this mailbox's mail actually ship?". Kept in its own module (not
 * the external-accounts CRUD file) because the decision is not
 * external-account-specific: both the outbound dispatcher and the onboarding
 * "first send" honesty gate (`mail/drafts.ts`) resolve through here so they
 * agree on which transport a message really uses.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { checkEmailDomainVerification } from '../domains/domains';
import { getMtaConfig } from './mtaClient';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';

/**
 * Where a mailbox's outbound mail actually ships. `hosted` = the Owlat MTA
 * path; `external` = the mail-sync worker driving the user's own SMTP. The
 * external variant never carries the password.
 */
export type MailboxTransport =
	| { kind: 'hosted' }
	| {
			kind: 'external';
			externalAccountId: Id<'externalMailAccounts'>;
			smtpHost: string;
			smtpPort: number;
			isSmtpSecure: boolean;
			smtpUsername: string;
			fromAddress: string;
	  };

/**
 * Outbound transport decision for a mailbox doc. Returns `{kind:'hosted'}` for
 * Owlat-hosted mailboxes (MTA path) or `{kind:'external', smtp…}` (mail-sync
 * worker path). Never returns the password.
 *
 * Both the dispatcher (`resolveOutboundTransport`) and the onboarding
 * "first send" honesty gate (`mail/drafts.ts`) resolve through here so they
 * agree on which transport a message really uses.
 */
export async function resolveMailboxTransport(
	ctx: QueryCtx | MutationCtx,
	mailbox: Doc<'mailboxes'>
): Promise<MailboxTransport> {
	if (mailbox.kind !== 'external' || !mailbox.externalAccountId) {
		return { kind: 'hosted' as const };
	}
	// Post-import "switch your sending": an external mailbox whose owner opted
	// into the instance transport ships through the hosted MTA path instead of
	// their own SMTP. The switch was gated on a verified from-domain + a
	// configured MTA (setSendingPreference), but the domain could have been
	// unverified/deleted or the transport removed since. Re-assert the gate
	// HERE so the DKIM-alignment claim stays true over time: if the instance
	// can no longer sign this from-domain, fall back to the user's own SMTP
	// rather than ship misaligned (or, on a torn-down MTA, silently dropped)
	// mail. undefined preference keeps the original external SMTP.
	if (mailbox.outboundPreference === 'instance') {
		const domainCheck = await checkEmailDomainVerification(ctx, mailbox.address);
		if (domainCheck.verified && getMtaConfig() !== null) {
			return { kind: 'hosted' as const };
		}
	}
	const account = await ctx.db.get(mailbox.externalAccountId);
	if (!account) return { kind: 'hosted' as const };
	return {
		kind: 'external' as const,
		externalAccountId: account._id,
		smtpHost: account.smtpHost,
		smtpPort: account.smtpPort,
		isSmtpSecure: account.isSmtpSecure,
		smtpUsername: account.smtpUsername ?? account.imapUsername,
		fromAddress: mailbox.address,
	};
}

/**
 * Outbound transport decision for a mailbox id (mail-sync worker / outbound
 * dispatcher surface, admin-key only). Thin wrapper over
 * {@link resolveMailboxTransport}.
 */
export const resolveOutboundTransport = internalQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<MailboxTransport> => {
		const mailbox = await ctx.db.get(args.mailboxId);
		if (!mailbox) return { kind: 'hosted' as const };
		return resolveMailboxTransport(ctx, mailbox);
	},
});
