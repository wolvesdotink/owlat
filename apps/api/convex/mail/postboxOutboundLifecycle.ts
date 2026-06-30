import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import {
	internalMutation,
	type MutationCtx,
} from '../_generated/server';
import { recordAuditLog } from '../lib/auditLog';

// ============================================================================
// Postbox outbound lifecycle — the single writer of every
// `mailMessages.outbound.recipients[].state` and the only producer of the
// derived `mailMessages.outbound.state` aggregate. See ADR-0012 and CONTEXT.md
// "Postbox outbound state" / "Postbox outbound lifecycle (module)".
//
// Unlike the Send lifecycle, this module transitions a *slice* of the row
// (one recipient) and re-derives the aggregate column after every transition.
// The aggregate is read-only — no caller writes it.
//
// Public surface:
//   - transition({ mailMessageId, recipientIdx, input })   — direct path,
//                                                            used by the
//                                                            synchronous
//                                                            dispatcher in
//                                                            mail/outbound.ts
//                                                            on per-recipient
//                                                            MTA POST failures.
//   - transitionByMtaMessageId({ rawProviderMessageId, input })
//                                                          — webhook path;
//                                                            parses the
//                                                            `pb-<id>-<idx>`
//                                                            prefix.
// ============================================================================

// ─── Types ──────────────────────────────────────────────────────────────────

export type RecipientState = 'queued' | 'sent' | 'bounced' | 'failed';
export type AggregateState = RecipientState | 'partial';

export type TransitionInput =
	| { to: 'sent'; at: number }
	| { to: 'bounced'; at: number; bounceMessage?: string }
	| { to: 'failed'; at: number; errorMessage: string; errorCode?: string };

export type TransitionOutcome =
	| {
			ok: true;
			applied: 'transitioned' | 'recorded';
			mailMessageId: Id<'mailMessages'>;
			recipientIdx: number;
			from: RecipientState;
			to: RecipientState;
			aggregateBefore: AggregateState;
			aggregateAfter: AggregateState;
	  }
	| {
			ok: false;
			reason:
				| 'message_not_found'
				| 'message_has_no_outbound'
				| 'recipient_not_found'
				| 'illegal_edge'
				| 'terminal'
				| 'unknown_mta_id_prefix';
			mailMessageId?: Id<'mailMessages'>;
			recipientIdx?: number;
			from?: RecipientState;
			to?: RecipientState;
	  };

// ─── Validators ─────────────────────────────────────────────────────────────

const transitionInputValidator = v.union(
	v.object({ to: v.literal('sent'), at: v.number() }),
	v.object({
		to: v.literal('bounced'),
		at: v.number(),
		bounceMessage: v.optional(v.string()),
	}),
	v.object({
		to: v.literal('failed'),
		at: v.number(),
		errorMessage: v.string(),
		errorCode: v.optional(v.string()),
	})
);

// ─── Legal-edges graph (per-recipient) ──────────────────────────────────────
//
// Mirrors the CONTEXT.md "Postbox outbound state" section. `bounced` and
// `failed` are terminal — outbound transitions are refused. Each recipient
// transitions independently; there is no row-wide downgrade guard.

const LEGAL_EDGES: Record<RecipientState, ReadonlySet<RecipientState>> = {
	queued: new Set<RecipientState>(['sent', 'bounced', 'failed']),
	sent: new Set<RecipientState>(['bounced']),
	bounced: new Set<RecipientState>(),
	failed: new Set<RecipientState>(),
};

// ─── Pure helpers ───────────────────────────────────────────────────────────

const POSTBOX_PREFIX = 'pb-';

/**
 * Parse an MTA messageId of the form `pb-<mailMessageId>-<idx>` into its
 * components. Returns null for any string that doesn't match the prefix or
 * has a malformed trailer.
 *
 * The `mailMessageId` portion is whatever the postbox dispatcher embedded
 * at queue time — Convex ids contain no dashes, so the *last* dash in the
 * remainder separates id from idx. Robust to future id-format changes as
 * long as the convention "id has no dashes, trailer is `-<integer>`" holds.
 */
export function parsePostboxMtaId(
	raw: string
): { mailMessageId: Id<'mailMessages'>; idx: number } | null {
	if (!raw.startsWith(POSTBOX_PREFIX)) return null;
	const remainder = raw.slice(POSTBOX_PREFIX.length);
	const lastDash = remainder.lastIndexOf('-');
	if (lastDash <= 0) return null;
	const idPart = remainder.slice(0, lastDash);
	const idxPart = remainder.slice(lastDash + 1);
	if (!/^\d+$/.test(idxPart)) return null;
	const idx = Number.parseInt(idxPart, 10);
	if (!Number.isFinite(idx) || idx < 0) return null;
	return {
		mailMessageId: idPart as unknown as Id<'mailMessages'>,
		idx,
	};
}

/**
 * Derive the aggregate `outbound.state` from the per-recipient array.
 * Empty input is defensive — the dispatcher always writes at least one
 * recipient, so this is unreachable under normal flow.
 */
export function deriveAggregateState(
	recipients: ReadonlyArray<{ state: RecipientState }>
): AggregateState {
	const [first, ...rest] = recipients;
	if (!first) return 'queued';
	for (const r of rest) {
		if (r.state !== first.state) return 'partial';
	}
	return first.state;
}

// ─── Effects ────────────────────────────────────────────────────────────────

type Effect = {
	kind: 'audit_log';
	mailMessageId: Id<'mailMessages'>;
	mailboxId: Id<'mailboxes'>;
	recipientIdx: number;
	from: RecipientState;
	to: RecipientState;
	aggregateBefore: AggregateState;
	aggregateAfter: AggregateState;
	at: number;
	details?: {
		bounceMessage?: string;
		errorMessage?: string;
		errorCode?: string;
	};
};

type RecipientRow = NonNullable<Doc<'mailMessages'>['outbound']>['recipients'][number];

type ReducerResult = {
	updatedRecipient: RecipientRow | null; // null when applied === 'recorded'
	effects: Effect[];
	applied: 'transitioned' | 'recorded';
	from: RecipientState;
	to: RecipientState;
};

// ─── Reducers ───────────────────────────────────────────────────────────────
//
// Each takes the existing recipient slice + the typed transition args and
// returns a ReducerResult. Reducers do NOT touch the DB or the scheduler —
// the runner applies the patch and dispatches effects.

function reduceSent(
	recipient: RecipientRow,
	args: Extract<TransitionInput, { to: 'sent' }>
): ReducerResult {
	const from = recipient.state;
	if (from === 'sent') {
		return {
			updatedRecipient: null,
			effects: [],
			applied: 'recorded',
			from,
			to: 'sent',
		};
	}
	return {
		updatedRecipient: {
			...recipient,
			state: 'sent',
			sentAt: args.at,
		},
		effects: [],
		applied: 'transitioned',
		from,
		to: 'sent',
	};
}

function reduceBounced(
	recipient: RecipientRow,
	args: Extract<TransitionInput, { to: 'bounced' }>
): ReducerResult {
	const from = recipient.state;
	if (from === 'bounced') {
		return {
			updatedRecipient: null,
			effects: [],
			applied: 'recorded',
			from,
			to: 'bounced',
		};
	}
	return {
		updatedRecipient: {
			...recipient,
			state: 'bounced',
			...(args.bounceMessage
				? { bounceMessage: args.bounceMessage }
				: {}),
		},
		effects: [],
		applied: 'transitioned',
		from,
		to: 'bounced',
	};
}

function reduceFailed(
	recipient: RecipientRow,
	args: Extract<TransitionInput, { to: 'failed' }>
): ReducerResult {
	const from = recipient.state;
	if (from === 'failed') {
		return {
			updatedRecipient: null,
			effects: [],
			applied: 'recorded',
			from,
			to: 'failed',
		};
	}
	return {
		updatedRecipient: {
			...recipient,
			state: 'failed',
			bounceMessage: args.errorMessage,
			...(args.errorCode ? { errorCode: args.errorCode } : {}),
		},
		effects: [],
		applied: 'transitioned',
		from,
		to: 'failed',
	};
}

// ─── Effects runner ─────────────────────────────────────────────────────────

async function applyEffects(
	ctx: MutationCtx,
	effects: ReadonlyArray<Effect>
): Promise<void> {
	for (const effect of effects) {
		switch (effect.kind) {
			case 'audit_log': {
				await recordAuditLog(ctx, {
					userId: 'system',
					action: 'postbox_outbound_transition',
					resource: 'mail_message',
					resourceId: effect.mailMessageId,
					details: {
						mailboxId: effect.mailboxId,
						recipientIdx: effect.recipientIdx,
						from: effect.from,
						to: effect.to,
						aggregateBefore: effect.aggregateBefore,
						aggregateAfter: effect.aggregateAfter,
						at: effect.at,
						...(effect.details?.bounceMessage !== undefined
							? { bounceMessage: effect.details.bounceMessage }
							: {}),
						...(effect.details?.errorMessage !== undefined
							? { errorMessage: effect.details.errorMessage }
							: {}),
						...(effect.details?.errorCode !== undefined
							? { errorCode: effect.details.errorCode }
							: {}),
					},
				});
				break;
			}
		}
	}
}

// ─── Dispatcher — the one place that fans transition kinds to reducers ─────

async function dispatch(
	ctx: MutationCtx,
	mailMessageId: Id<'mailMessages'>,
	recipientIdx: number,
	input: TransitionInput
): Promise<TransitionOutcome> {
	const message = await ctx.db.get(mailMessageId);
	if (!message) return { ok: false, reason: 'message_not_found' };
	if (!message.outbound) {
		return {
			ok: false,
			reason: 'message_has_no_outbound',
			mailMessageId,
		};
	}

	const recipients = message.outbound.recipients;
	const recipient = recipients.find((r) => r.idx === recipientIdx);
	if (!recipient) {
		return {
			ok: false,
			reason: 'recipient_not_found',
			mailMessageId,
			recipientIdx,
		};
	}

	const from = recipient.state;
	const aggregateBefore = message.outbound.state;
	const isLegalEdge = LEGAL_EDGES[from].has(input.to);
	const isSelfLoop = from === input.to;

	if (!isLegalEdge && !isSelfLoop) {
		if (LEGAL_EDGES[from].size === 0) {
			return {
				ok: false,
				reason: 'terminal',
				mailMessageId,
				recipientIdx,
				from,
				to: input.to,
			};
		}
		return {
			ok: false,
			reason: 'illegal_edge',
			mailMessageId,
			recipientIdx,
			from,
			to: input.to,
		};
	}

	let result: ReducerResult;
	switch (input.to) {
		case 'sent':
			result = reduceSent(recipient, input);
			break;
		case 'bounced':
			result = reduceBounced(recipient, input);
			break;
		case 'failed':
			result = reduceFailed(recipient, input);
			break;
	}

	let aggregateAfter: AggregateState = aggregateBefore;

	if (result.updatedRecipient) {
		const nextRecipients = recipients.map((r) =>
			r.idx === recipientIdx ? result.updatedRecipient! : r
		);
		aggregateAfter = deriveAggregateState(nextRecipients);
		await ctx.db.patch(mailMessageId, {
			outbound: {
				state: aggregateAfter,
				recipients: nextRecipients,
			},
			updatedAt: Date.now(),
		});
	}

	// Build the audit-log effect AFTER the patch so we have the final
	// aggregate. The reducer doesn't know about the aggregate; the runner
	// does.
	const auditEffect: Effect = {
		kind: 'audit_log',
		mailMessageId,
		mailboxId: message.mailboxId,
		recipientIdx,
		from: result.from,
		to: result.to,
		aggregateBefore,
		aggregateAfter,
		at: input.at,
		details: {
			...(input.to === 'bounced' && input.bounceMessage !== undefined
				? { bounceMessage: input.bounceMessage }
				: {}),
			...(input.to === 'failed'
				? {
						errorMessage: input.errorMessage,
						...(input.errorCode !== undefined
							? { errorCode: input.errorCode }
							: {}),
					}
				: {}),
		},
	};

	await applyEffects(ctx, [auditEffect, ...result.effects]);

	return {
		ok: true,
		applied: result.applied,
		mailMessageId,
		recipientIdx,
		from: result.from,
		to: result.to,
		aggregateBefore,
		aggregateAfter,
	};
}

// ─── Public mutations ───────────────────────────────────────────────────────

/**
 * Transition one recipient's state on a `mailMessages.outbound` row.
 *
 * Called by the synchronous dispatcher (`mail/outbound.ts:dispatchDraft`)
 * inside the per-recipient MTA POST loop: 5xx → `to: 'bounced'`,
 * network error → `to: 'failed'`.
 *
 * Atomic with: per-recipient state patch, aggregate re-derivation,
 * audit_log effect. Duplicate / illegal / terminal transitions are
 * reported via TransitionOutcome — never thrown.
 */
export const transition = internalMutation({
	args: {
		mailMessageId: v.id('mailMessages'),
		recipientIdx: v.number(),
		input: transitionInputValidator,
	},
	handler: async (ctx, args): Promise<TransitionOutcome> => {
		return await dispatch(
			ctx,
			args.mailMessageId,
			args.recipientIdx,
			args.input
		);
	},
});

/**
 * Same as `transition`, but the caller has the raw `pb-<id>-<idx>` MTA
 * messageId rather than the parsed (id, idx) pair. Parses internally.
 *
 * Used by the Webhook dispatcher when an `email.sent` / `email.bounced`
 * event arrives for a postbox dispatch.
 */
export const transitionByMtaMessageId = internalMutation({
	args: {
		rawProviderMessageId: v.string(),
		input: transitionInputValidator,
	},
	handler: async (ctx, args): Promise<TransitionOutcome> => {
		const parsed = parsePostboxMtaId(args.rawProviderMessageId);
		if (!parsed) return { ok: false, reason: 'unknown_mta_id_prefix' };
		return await dispatch(ctx, parsed.mailMessageId, parsed.idx, args.input);
	},
});
