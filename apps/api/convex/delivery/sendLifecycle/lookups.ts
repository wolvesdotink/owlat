import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { normalizeEmail } from '../../lib/inputGuards';
import type {
	EmailSendDoc,
	SendRef,
	TransactionalSendDoc,
} from './types';

// ─── SendStore — the only place that branches on kind to load/patch ─────────

export async function loadSend(
	ctx: MutationCtx,
	ref: SendRef
): Promise<EmailSendDoc | TransactionalSendDoc | null> {
	return await ctx.db.get(ref.id);
}

export async function resolveProviderMessageId(
	ctx: MutationCtx,
	providerMessageId: string
): Promise<SendRef | null> {
	const emailSend = await ctx.db
		.query('emailSends')
		.withIndex('by_provider_message_id', (q) =>
			q.eq('providerMessageId', providerMessageId)
		)
		.first();
	if (emailSend) return { kind: 'campaign', id: emailSend._id };

	const txSend = await ctx.db
		.query('transactionalSends')
		.withIndex('by_provider_message_id', (q) =>
			q.eq('providerMessageId', providerMessageId)
		)
		.first();
	if (txSend) return { kind: 'transactional', id: txSend._id };

	return null;
}

// ─── Sender-domain lookup (for reputation_update) ───────────────────────────

export async function senderDomainFor(
	ctx: MutationCtx,
	send: EmailSendDoc | TransactionalSendDoc,
	ref: SendRef
): Promise<string | undefined> {
	if (ref.kind === 'campaign') {
		const campaign = await ctx.db.get((send as EmailSendDoc).campaignId);
		return campaign?.fromEmail?.split('@')[1]?.toLowerCase();
	}
	const settings = await ctx.db.query('instanceSettings').first();
	return settings?.defaultFromEmail?.split('@')[1]?.toLowerCase();
}

// ─── Contact-email lookup ───────────────────────────────────────────────────
//
// emailSends has a denormalized `contactEmail` (SNAPSHOT field, never updated
// after write). transactionalSends carries the recipient as `email`.

export function contactEmailOf(
	send: EmailSendDoc | TransactionalSendDoc
): string {
	if ('contactEmail' in send) return send.contactEmail;
	return (send as TransactionalSendDoc).email;
}

// ─── Recipient-contact lookup (for the soft-bounce counter) ─────────────────
//
// The per-recipient soft-bounce counter lives on the `contacts` row, NOT the
// send row, so it accumulates across the recipient's whole send history (a
// chronically-4xx address mailed by many campaigns). Resolve the contact by
// the send's `contactId` when present, else by the (normalized) recipient
// email — this also covers contact-less transactional sends that still hit a
// known address. Returns null when no contact backs the address (e.g. a
// one-off transactional send to a non-contact); the counter is simply skipped.
export async function resolveRecipientContact(
	ctx: MutationCtx,
	send: EmailSendDoc | TransactionalSendDoc
): Promise<Doc<'contacts'> | null> {
	if (send.contactId) {
		const byId = await ctx.db.get(send.contactId);
		if (byId) return byId;
	}
	const normalized = normalizeEmail(contactEmailOf(send));
	if (!normalized) return null;
	return await ctx.db
		.query('contacts')
		.withIndex('by_email', (q) => q.eq('email', normalized))
		.first();
}

// ─── Non-campaign contact-activity provenance ───────────────────────────────
//
// A `transactionalSends` row now backs three non-campaign sources discriminated
// by its own `kind` field (transactional | automation | agent_reply). The
// contact-activity metadata mirrors that: `emailType` echoes the row kind, and
// the provenance id (`transactionalEmailId` / `automationId`) is included only
// when present. `agent_reply` carries no provenance id (the inbound message id
// lives on the row, not on the contact-activity metadata).
export function nonCampaignActivityProvenance(send: TransactionalSendDoc): {
	emailType: string;
	transactionalEmailId?: string;
	automationId?: string;
} {
	return {
		emailType: send.kind,
		...nonCampaignBounceProvenance(send),
	};
}

// Provenance ids only (no `emailType`) — the email_bounced / email_complained
// activity schemas carry `transactionalEmailId` + `automationId` but no type tag.
export function nonCampaignBounceProvenance(send: TransactionalSendDoc): {
	transactionalEmailId?: string;
	automationId?: string;
} {
	return {
		...(send.transactionalEmailId
			? { transactionalEmailId: String(send.transactionalEmailId) }
			: {}),
		...(send.automationId ? { automationId: String(send.automationId) } : {}),
	};
}
