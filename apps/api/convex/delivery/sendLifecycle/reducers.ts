import type { Effect } from './effects';
import { contactEmailOf, nonCampaignActivityProvenance } from './lookups';
import type {
	EmailSendDoc,
	ReducerResult,
	SendRef,
	SendStatus,
	TransactionalSendDoc,
	TransitionInput,
} from './types';

// ============================================================================
// Send lifecycle — pure reducers + the legal-edges graph.
//
// Each reducer takes the loaded Send + the typed transition args and returns a
// ReducerResult ({ patch, effects, applied, from, to }). Reducers do NOT touch
// the DB or the scheduler — the runner (`applyEffects` in ./effects) applies
// the patch and dispatches effects. This is the internal seam: pure reducers,
// observable patch+effects output. Because nothing here imports `ctx`, the
// reducers are directly unit-testable.
//
// This file holds the legal-edges DAG + the lifecycle reducers
// (sent/failed/delivered/opened/clicked). The two deliverability-feedback
// reducers (bounced/complained) live in ./feedbackReducers to keep both files
// under the ~500 LOC cap; they are re-exported below so the whole reducer
// family is importable from this one path. Shared types live in ./types.
//
// See CONTEXT.md "Send lifecycle" for the domain vocabulary (Send, SendRef,
// Send status). The state graph here mirrors the CONTEXT.md "Send status"
// section exactly — do not change one without the other.
// ============================================================================

// Re-export the shared types + the feedback reducers so callers and unit tests
// import the entire reducer family (+ its vocabulary) from `./reducers`.
export type {
	SendKind,
	SendRef,
	SendStatus,
	TransitionInput,
	TransitionOutcome,
	EmailSendDoc,
	TransactionalSendDoc,
	ReducerResult,
} from './types';
export { reduceBounced, reduceComplained } from './feedbackReducers';

// ─── Legal-edges graph ──────────────────────────────────────────────────────
//
// Source-of-truth for the lifecycle DAG. Mirrors CONTEXT.md "Send status"
// exactly. Maps current status → set of legal next statuses (status-changing
// edges). `opened` and `clicked` self-loops (re-firing the same event) are
// handled by the reducer as `recorded` outcomes, not status changes.
//
// `bounced` is terminal ONLY for a HARD bounce. A SOFT bounce also lands in
// `bounced` (with `bounceType: 'soft'`) but is NON-terminal: the same Send may
// later receive a hard bounce or a complaint on the same address, which must be
// recorded — not rejected as `terminal` and lost. Terminality is therefore
// computed by `legalEdgesFor(send)` (which reads `bounceType`), not by the
// static map alone.

export const LEGAL_EDGES: Record<SendStatus, ReadonlySet<SendStatus>> = {
	queued: new Set<SendStatus>(['sent', 'failed']),
	sent: new Set<SendStatus>(['delivered', 'opened', 'clicked', 'bounced', 'complained']),
	failed: new Set<SendStatus>(),
	delivered: new Set<SendStatus>(['opened', 'clicked', 'bounced', 'complained']),
	opened: new Set<SendStatus>(['clicked', 'bounced', 'complained']),
	clicked: new Set<SendStatus>(['bounced', 'complained']),
	bounced: new Set<SendStatus>(),
	complained: new Set<SendStatus>(),
};

// Outgoing edges from a soft-bounced row: it may harden (a later hard bounce)
// or draw a complaint. A soft → soft re-report is handled as a `recorded`
// self-loop by `reduceBounced` (counter bump, no status change).
const SOFT_BOUNCED_LEGAL_EDGES: ReadonlySet<SendStatus> = new Set<SendStatus>([
	'bounced',
	'complained',
]);

// Effective legal-edge set for a loaded Send, accounting for the soft-bounce
// exception above. All non-`bounced` states use the static map.
export function legalEdgesFor(send: EmailSendDoc | TransactionalSendDoc): ReadonlySet<SendStatus> {
	const from = send.status as SendStatus;
	if (from === 'bounced' && send.bounceType === 'soft') {
		return SOFT_BOUNCED_LEGAL_EDGES;
	}
	return LEGAL_EDGES[from];
}

// Per ADR-0006: transactional sends pre-create in `queued` and walk
// `queued → sent` / `queued → failed` through this lifecycle the same way
// campaign sends do — the historical CAMPAIGN_ONLY_TARGETS guard is gone.

// ─── Reducers ───────────────────────────────────────────────────────────────

export function reduceSent(
	send: EmailSendDoc | TransactionalSendDoc,
	args: Extract<TransitionInput, { to: 'sent' }>,
	ref: SendRef,
	senderDomain: string | undefined
): ReducerResult {
	const from = send.status as SendStatus;
	if (from === 'sent') {
		return {
			patch: {},
			effects: [],
			applied: 'duplicate',
			from,
			to: 'sent',
		};
	}
	const effects: Effect[] = [];

	// Campaign-only counter bump. Transactional has no per-template `sent`
	// counter — the global `instanceSettings.transactionalSendCount` was the
	// old proxy and is no longer wired (queue-time creation will own that
	// counter; see ADR-0006).
	if (ref.kind === 'campaign') {
		effects.push({
			kind: 'campaign_stats_sent',
			campaignId: (send as EmailSendDoc).campaignId,
		});
	}

	// Daily roll-up — both kinds. The Dashboard summary card reads the
	// last 30 of these rows; the pre-roll-up shape did `.collect()` and
	// `.take(5000)` on every subscriber.
	effects.push({ kind: 'daily_stats_bump', field: 'sent', at: args.at });

	// Sending-reputation `send` event (deployment + sending-domain scope). Both
	// kinds count toward reputation: bounce/complaint rates divide by this
	// `totalSent`, and the auto-enforce escalation needs the real denominator,
	// so every outbound — campaign or transactional — must be recorded here.
	effects.push({
		kind: 'reputation_update',
		eventType: 'send',
		domain: senderDomain,
	});

	// Customer webhook fires for both kinds. The payload tells the
	// subscriber which kind by which id is populated.
	effects.push({
		kind: 'customer_webhook',
		spec: {
			literal: 'email.sent',
			input: {
				email: contactEmailOf(send),
				campaignId: ref.kind === 'campaign' ? (send as EmailSendDoc).campaignId : null,
				transactionalEmailId:
					ref.kind === 'transactional'
						? ((send as TransactionalSendDoc).transactionalEmailId ?? null)
						: null,
				at: args.at,
			},
		},
	});

	// Per-contact activity row (when we know which contact this dispatch
	// is for). Mirrors the existing email_bounced / email_complained
	// effects on the bounced / complained reducers.
	if (send.contactId) {
		effects.push({
			kind: 'contact_activity',
			literal: 'email_sent',
			contactId: send.contactId,
			metadata:
				ref.kind === 'campaign'
					? {
							campaignId: String((send as EmailSendDoc).campaignId),
							emailType: 'campaign',
							...((send as EmailSendDoc).personalizedSubject
								? {
										emailSubject: (send as EmailSendDoc).personalizedSubject,
									}
								: {}),
						}
					: {
							...nonCampaignActivityProvenance(send as TransactionalSendDoc),
							...((send as TransactionalSendDoc).subject
								? {
										emailSubject: (send as TransactionalSendDoc).subject,
									}
								: {}),
						},
			occurredAt: args.at,
		});
	}

	// Terminal worker outcome: drop attachment storage blobs that were
	// captured on the Send row at queue time. Only transactional Sends
	// carry attachmentStorageIds — campaign rows have no such field, so
	// the check is field-presence safe.
	const attachmentIds = (send as TransactionalSendDoc).attachmentStorageIds;
	if (attachmentIds && attachmentIds.length > 0) {
		effects.push({ kind: 'attachment_cleanup', storageIds: attachmentIds });
	}

	return {
		patch: {
			status: 'sent',
			sentAt: args.at,
			providerMessageId: args.providerMessageId,
			...(args.providerType ? { providerType: args.providerType } : {}),
		},
		effects,
		applied: 'transitioned',
		from,
		to: 'sent',
	};
}

export function reduceFailed(
	send: EmailSendDoc | TransactionalSendDoc,
	args: Extract<TransitionInput, { to: 'failed' }>,
	ref: SendRef
): ReducerResult {
	const from = send.status as SendStatus;
	if (from === 'failed') {
		return {
			patch: {},
			effects: [],
			applied: 'duplicate',
			from,
			to: 'failed',
		};
	}
	const effects: Effect[] = [];
	if (ref.kind === 'campaign') {
		effects.push({
			kind: 'campaign_stats_failed',
			campaignId: (send as EmailSendDoc).campaignId,
		});
	}
	const attachmentIds = (send as TransactionalSendDoc).attachmentStorageIds;
	if (attachmentIds && attachmentIds.length > 0) {
		effects.push({ kind: 'attachment_cleanup', storageIds: attachmentIds });
	}
	return {
		patch: {
			status: 'failed',
			errorMessage: args.errorMessage,
			errorCode: args.errorCode,
		},
		effects,
		applied: 'transitioned',
		from,
		to: 'failed',
	};
}

export function reduceDelivered(
	send: EmailSendDoc | TransactionalSendDoc,
	_args: Extract<TransitionInput, { to: 'delivered' }>
): ReducerResult {
	const from = send.status as SendStatus;
	// Delivery observation is independent from display status. Only `sent`
	// advances to `delivered`; late acceptance after open/click/complaint is an
	// attributable duplicate and must never regress the visible lifecycle.
	if (from !== 'sent') {
		return {
			patch: {},
			effects: [],
			applied: 'duplicate',
			from,
			to: 'delivered',
		};
	}
	return {
		patch: { status: 'delivered' },
		effects: [],
		applied: 'transitioned',
		from,
		to: 'delivered',
	};
}

export function reduceOpened(
	send: EmailSendDoc | TransactionalSendDoc,
	args: Extract<TransitionInput, { to: 'opened' }>,
	ref: SendRef
): ReducerResult {
	const from = send.status as SendStatus;
	const openCount = (send.openCount ?? 0) + 1;
	const isFirstOpen = !send.openedAt;

	// Always record the open (counter bump) — even on terminal Send rows.
	const patch: Record<string, unknown> = { openCount };

	// Status only moves on the first open AND from a non-terminal state.
	if (isFirstOpen && from !== 'bounced' && from !== 'complained') {
		patch['status'] = 'opened';
		patch['openedAt'] = args.at;
	}

	const effects: Effect[] = [];
	if (isFirstOpen && ref.kind === 'campaign') {
		effects.push({
			kind: 'campaign_stats_opened',
			campaignId: (send as EmailSendDoc).campaignId,
			at: args.at,
		});
	}
	if (isFirstOpen) {
		// Unique opens — drives the dashboard openRate denominator.
		effects.push({ kind: 'daily_stats_bump', field: 'opened', at: args.at });
		// Customer webhook — first open only; re-opens just bump openCount.
		effects.push({
			kind: 'customer_webhook',
			spec: {
				literal: 'email.opened',
				input: { email: contactEmailOf(send), at: args.at },
			},
		});
	}

	return {
		patch,
		effects,
		applied: isFirstOpen && patch['status'] === 'opened' ? 'transitioned' : 'recorded',
		from,
		to: 'opened',
	};
}

export function reduceClicked(
	send: EmailSendDoc | TransactionalSendDoc,
	args: Extract<TransitionInput, { to: 'clicked' }>,
	ref: SendRef
): ReducerResult {
	const from = send.status as SendStatus;
	const clickedLinks = [...(send.clickedLinks ?? []), { url: args.url, clickedAt: args.at }];
	const isFirstClick = !send.clickedAt;

	const patch: Record<string, unknown> = { clickedLinks };

	if (isFirstClick && from !== 'bounced' && from !== 'complained') {
		patch['status'] = 'clicked';
		patch['clickedAt'] = args.at;
	}

	const effects: Effect[] = [];
	if (isFirstClick && ref.kind === 'campaign') {
		effects.push({
			kind: 'campaign_stats_clicked',
			campaignId: (send as EmailSendDoc).campaignId,
			at: args.at,
		});
	}
	if (isFirstClick) {
		// Unique clicks — drives the dashboard clickRate denominator.
		effects.push({ kind: 'daily_stats_bump', field: 'clicked', at: args.at });
	}

	// Customer webhook — every click, not just the first: each carries its own
	// `url`, so subscribers receive one event per tracked-link click.
	effects.push({
		kind: 'customer_webhook',
		spec: {
			literal: 'email.clicked',
			input: { email: contactEmailOf(send), url: args.url, at: args.at },
		},
	});

	return {
		patch,
		effects,
		applied: isFirstClick && patch['status'] === 'clicked' ? 'transitioned' : 'recorded',
		from,
		to: 'clicked',
	};
}
