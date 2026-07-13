/** Query handlers and shared read-side helpers for personal-mail drafts. */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { isFeatureEnabled } from '../lib/featureFlags';
import { openMailDraftBody } from '../lib/messageBody';
import { requireMailboxAccess } from './permissions';
import { getMailSyncConfig, getMtaConfig } from './mtaClient';
import { resolveMailboxTransport } from './outboundTransport';
import { hasActiveSigningKey, loadRecipientKeyStates } from './outboundQueries';
import { deriveSealState, type SealState } from './sealPolicy';

/**
 * True iff this mailbox has the same outbound transport the dispatcher would
 * use. Shared by the read-side onboarding gate and the send-time milestone.
 */
export async function mailboxHasSendTransport(
	ctx: QueryCtx | MutationCtx,
	mailbox: Doc<'mailboxes'>
): Promise<boolean> {
	const transport = await resolveMailboxTransport(ctx, mailbox);
	return transport.kind === 'external' ? getMailSyncConfig() !== null : getMtaConfig() !== null;
}

export async function canSendFromHandler(
	ctx: QueryCtx,
	args: { mailboxId: Id<'mailboxes'> }
): Promise<boolean> {
	const owned = await requireMailboxAccess(ctx, args.mailboxId);
	if (!owned.ok) return false;
	return mailboxHasSendTransport(ctx, owned.mailbox);
}

export async function getDraftHandler(ctx: QueryCtx, args: { draftId: Id<'mailDrafts'> }) {
	const draft = await ctx.db.get(args.draftId);
	if (!draft) return null;
	const owned = await requireMailboxAccess(ctx, draft.mailboxId);
	if (!owned.ok) return null;
	return await openMailDraftBody(draft);
}

/**
 * Derive the composer's seal promise from the same policy, recipient-key, and
 * sender-signing-key inputs used by dispatch, without exposing private keys.
 */
export async function getComposerSealStateHandler(
	ctx: QueryCtx,
	args: { draftId: Id<'mailDrafts'> }
): Promise<SealState | null> {
	const draft = await ctx.db.get(args.draftId);
	if (!draft) return null;
	const owned = await requireMailboxAccess(ctx, draft.mailboxId);
	if (!owned.ok) return null;
	if (!(await isFeatureEnabled(ctx, 'sealedMail'))) {
		return { kind: 'cannotSeal', reason: 'flag_off' };
	}
	const settings = await ctx.db.query('instanceSettings').first();
	const policy = settings?.sealPolicy ?? 'auto';
	const recipients = await loadRecipientKeyStates(ctx, [
		...draft.toAddresses,
		...draft.ccAddresses,
		...draft.bccAddresses,
	]);
	const hasSigningKey = await hasActiveSigningKey(ctx, draft.fromAddress);
	return deriveSealState(policy, recipients, hasSigningKey);
}

export async function listForMailboxHandler(ctx: QueryCtx, args: { mailboxId: Id<'mailboxes'> }) {
	const owned = await requireMailboxAccess(ctx, args.mailboxId);
	if (!owned.ok) return [];
	const drafts = await ctx.db
		.query('mailDrafts')
		.withIndex('by_mailbox_and_edited', (q) => q.eq('mailboxId', args.mailboxId))
		.order('desc')
		.take(100);
	return await Promise.all(drafts.map((draft) => openMailDraftBody(draft)));
}

export async function getInternalHandler(ctx: QueryCtx, args: { draftId: Id<'mailDrafts'> }) {
	const draft = await ctx.db.get(args.draftId);
	return draft === null ? null : await openMailDraftBody(draft);
}
