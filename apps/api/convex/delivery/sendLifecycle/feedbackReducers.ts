import type { Doc } from '../../_generated/dataModel';
import type { Effect } from './effects';
import { nonCampaignBounceProvenance } from './lookups';
import type {
	EmailSendDoc,
	ReducerResult,
	SendRef,
	SendStatus,
	TransactionalSendDoc,
	TransitionInput,
} from './types';

// ============================================================================
// Send lifecycle — deliverability-feedback reducers.
//
// `reduceBounced` / `reduceComplained` are the negative-feedback half of the
// reducer family (the part that touches the blocklist + the per-recipient
// soft-bounce counter). Split out of ./reducers purely to keep each file under
// the ~500 LOC cap (CONVENTIONS.md "Split only above ~500 LOC"); ./reducers
// re-exports both so callers and unit tests import the whole family from one
// path. Same pure-reducer contract: no `ctx`, output is { patch, effects }.
// ============================================================================

// ─── Soft-bounce suppression threshold ──────────────────────────────────────
//
// RFC 3463 4.x.x bounces (e.g. 5.2.2 mailbox-full) are TRANSIENT — a single
// soft bounce is not a reason to suppress, because the address may recover.
// But a chronically-4xx address must eventually be suppressed or it gets mailed
// forever, dragging down sender reputation (the standard ESP
// "suppress-after-N-soft" practice). We track a per-recipient running soft-
// bounce count on the contact row, escalate to the blocklist once it reaches
// this threshold, and reset it on the next successful delivery.
const SOFT_BOUNCE_SUPPRESSION_THRESHOLD = 5;

export function reduceBounced(
	send: EmailSendDoc | TransactionalSendDoc,
	args: Extract<TransitionInput, { to: 'bounced' }>,
	ref: SendRef,
	contactEmail: string,
	senderDomain: string | undefined,
	// Recipient contact resolved by email (may be null for an unknown address
	// or a contact-less transactional send) — carries the running soft-bounce
	// counter that drives suppress-after-N escalation.
	recipientContact: Doc<'contacts'> | null
): ReducerResult {
	const from = send.status as SendStatus;
	const wasHardBounced = from === 'bounced' && send.bounceType === 'hard';
	const wasSoftBounced = from === 'bounced' && send.bounceType === 'soft';

	// A hard bounce is TERMINAL. Once a row is hard-bounced, any later bounce
	// report (hard or soft) is a no-op — the address is already suppressed and
	// the soft counter must not advance off a row that is permanently dead.
	if (wasHardBounced) {
		return {
			patch: {},
			effects: [],
			applied: 'duplicate',
			from,
			to: 'bounced',
		};
	}

	// A hard bounce on a soft-bounced (or sent/delivered) row HARDENS it.
	const isHard = args.bounceType === 'hard';

	// A SOFT bounce re-reported on an already-soft-bounced SAME send is a no-op:
	// the per-recipient counter is bumped ONCE per send (on the first soft
	// bounce for that send), so a retried/duplicate soft webhook for the same
	// send can't inflate it. Distinct sends to the same address each contribute
	// one increment — that's what drives suppress-after-N across a recipient's
	// history (the counter lives on the contact, not the send).
	if (wasSoftBounced && !isHard) {
		return {
			patch: {},
			effects: [],
			applied: 'duplicate',
			from,
			to: 'bounced',
		};
	}

	const effects: Effect[] = [];

	// ── Per-recipient soft-bounce counter + suppress-after-N escalation ──────
	// Increment on every soft bounce; escalate to the blocklist exactly once,
	// at the moment the running count first reaches the threshold. Hardening a
	// soft bounce blocklists via the hard path below, so it does not also
	// trip the soft escalation.
	if (!isHard && recipientContact) {
		const newCount = (recipientContact.softBounceCount ?? 0) + 1;
		effects.push({
			kind: 'contact_soft_bounce_count',
			contactId: recipientContact._id,
			count: newCount,
		});
		if (newCount === SOFT_BOUNCE_SUPPRESSION_THRESHOLD) {
			effects.push({
				kind: 'blocklist_insert',
				email: contactEmail,
				reason: 'bounced',
				bounceType: 'soft',
				source: ref,
			});
		}
	}

	if (isHard) {
		effects.push({
			kind: 'blocklist_insert',
			email: contactEmail,
			reason: 'bounced',
			bounceType: 'hard',
			source: ref,
		});
	}

	if (send.contactId) {
		effects.push({
			kind: 'contact_activity',
			literal: 'email_bounced',
			contactId: send.contactId,
			metadata: {
				...(ref.kind === 'campaign'
					? { campaignId: String((send as EmailSendDoc).campaignId) }
					: nonCampaignBounceProvenance(send as TransactionalSendDoc)),
				bounceType: args.bounceType,
				...(args.bounceMessage ? { errorMessage: args.bounceMessage } : {}),
			},
			occurredAt: args.at,
		});
	}

	if (ref.kind === 'campaign') {
		effects.push({
			kind: 'campaign_stats_bounced',
			campaignId: (send as EmailSendDoc).campaignId,
			isHard,
			at: args.at,
		});
	}

	effects.push({
		kind: 'reputation_update',
		eventType: isHard ? 'hard_bounce' : 'bounce',
		domain: senderDomain,
	});

	effects.push({
		kind: 'customer_webhook',
		spec: {
			literal: 'email.bounced',
			input: {
				email: contactEmail,
				bounceType: args.bounceType,
				...(args.bounceMessage ? { message: args.bounceMessage } : {}),
				at: args.at,
			},
		},
	});

	// Every path that reaches here is a real status change: the first
	// sent/delivered/opened/clicked → bounced, or a soft → hard hardening (the
	// patch overwrites `bounceType` from 'soft' to 'hard'). Duplicate hard and
	// repeat-soft cases returned above.
	const patch: Record<string, unknown> = {
		status: 'bounced',
		bouncedAt: args.at,
		bounceType: args.bounceType,
		...(args.bounceMessage ? { errorMessage: args.bounceMessage } : {}),
	};

	return {
		patch,
		effects,
		applied: 'transitioned',
		from,
		to: 'bounced',
	};
}

export function reduceComplained(
	send: EmailSendDoc | TransactionalSendDoc,
	args: Extract<TransitionInput, { to: 'complained' }>,
	ref: SendRef,
	contactEmail: string,
	senderDomain: string | undefined
): ReducerResult {
	const from = send.status as SendStatus;
	if (from === 'complained') {
		return {
			patch: {},
			effects: [],
			applied: 'duplicate',
			from,
			to: 'complained',
		};
	}

	const patch: Record<string, unknown> = {
		status: 'complained',
		complainedAt: args.at,
	};

	const effects: Effect[] = [];

	effects.push({
		kind: 'blocklist_insert',
		email: contactEmail,
		reason: 'complained',
		source: ref,
	});

	if (send.contactId) {
		effects.push({
			kind: 'contact_activity',
			literal: 'email_complained',
			contactId: send.contactId,
			metadata: ref.kind === 'campaign'
				? { campaignId: String((send as EmailSendDoc).campaignId) }
				: nonCampaignBounceProvenance(send as TransactionalSendDoc),
			occurredAt: args.at,
		});
	}

	if (ref.kind === 'campaign') {
		effects.push({
			kind: 'content_scan_complaint',
			campaignId: (send as EmailSendDoc).campaignId,
			contactEmail,
		});
	}

	effects.push({
		kind: 'reputation_update',
		eventType: 'complaint',
		domain: senderDomain,
	});

	effects.push({
		kind: 'customer_webhook',
		spec: {
			literal: 'email.complained',
			input: {
				email: contactEmail,
				at: args.at,
			},
		},
	});

	return {
		patch,
		effects,
		applied: 'transitioned',
		from,
		to: 'complained',
	};
}
