import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { recordPostboxOutboundAudit, type PostboxOutboundAuditEvent } from './postboxOutboundAudit';

// Postbox outbound lifecycle — the single writer of every
// `mailMessages.outbound.recipients[].state` and the only producer of the
// derived `mailMessages.outbound.state` aggregate. See ADR-0012 and CONTEXT.md
// "Postbox outbound state" / "Postbox outbound lifecycle (module)".
//
// Unlike the Send lifecycle, this module transitions a *slice* of the row
// (one recipient) and re-derives the aggregate column after every transition.
// The aggregate is read-only — no caller writes it.
//
// The direct mutation serves synchronous dispatch failures; MTA-keyed
// mutations serve webhook transitions and independent acceptance evidence.
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

// Mirrors the CONTEXT.md "Postbox outbound state" section. `bounced` and
// `failed` are terminal — outbound transitions are refused. Each recipient
// transitions independently; there is no row-wide downgrade guard.

const LEGAL_EDGES: Record<RecipientState, ReadonlySet<RecipientState>> = {
	queued: new Set<RecipientState>(['sent', 'bounced', 'failed']),
	sent: new Set<RecipientState>(['bounced']),
	bounced: new Set<RecipientState>(),
	failed: new Set<RecipientState>(),
};

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

type RecipientRow = NonNullable<Doc<'mailMessages'>['outbound']>['recipients'][number];
type OutboundMessage = Doc<'mailMessages'> & {
	outbound: NonNullable<Doc<'mailMessages'>['outbound']>;
};

type LoadedRecipient = {
	message: OutboundMessage;
	recipients: RecipientRow[];
	recipient: RecipientRow;
};

type FailedRecipientLookup = Extract<TransitionOutcome, { ok: false }>;

type ReducerResult = {
	updatedRecipient: RecipientRow | null; // null when applied === 'recorded'
	applied: 'transitioned' | 'recorded';
	from: RecipientState;
	to: RecipientState;
};

// Each takes the existing recipient slice + the typed transition args and
// returns a ReducerResult. Reducers do not touch the DB or audit log.

function reduceSent(
	recipient: RecipientRow,
	args: Extract<TransitionInput, { to: 'sent' }>
): ReducerResult {
	const from = recipient.state;
	if (from === 'sent') {
		return {
			updatedRecipient: null,
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
			applied: 'recorded',
			from,
			to: 'bounced',
		};
	}
	return {
		updatedRecipient: {
			...recipient,
			state: 'bounced',
			bouncedAt: args.at,
			...(args.bounceMessage ? { bounceMessage: args.bounceMessage } : {}),
		},
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
			applied: 'recorded',
			from,
			to: 'failed',
		};
	}
	return {
		updatedRecipient: {
			...recipient,
			state: 'failed',
			failedAt: args.at,
			bounceMessage: args.errorMessage,
			...(args.errorCode ? { errorCode: args.errorCode } : {}),
		},
		applied: 'transitioned',
		from,
		to: 'failed',
	};
}

async function loadRecipient(
	ctx: MutationCtx,
	mailMessageId: Id<'mailMessages'>,
	recipientIdx: number
): Promise<LoadedRecipient | FailedRecipientLookup> {
	const message = await ctx.db.get(mailMessageId);
	if (!message) return { ok: false, reason: 'message_not_found' };
	if (!message.outbound) {
		return { ok: false, reason: 'message_has_no_outbound', mailMessageId };
	}
	const recipients = message.outbound.recipients;
	const recipient = recipients.find((candidate) => candidate.idx === recipientIdx);
	if (!recipient) {
		return { ok: false, reason: 'recipient_not_found', mailMessageId, recipientIdx };
	}
	return { message: message as OutboundMessage, recipients, recipient };
}

function canAttributeRemoteAcceptance(recipient: RecipientRow, acceptedAt: number): boolean {
	if (recipient.acceptedAt !== undefined) return true;
	if (recipient.state === 'bounced') {
		return recipient.bouncedAt !== undefined && acceptedAt <= recipient.bouncedAt;
	}
	if (recipient.state === 'failed') {
		return recipient.failedAt !== undefined && acceptedAt <= recipient.failedAt;
	}
	return true;
}

async function dispatch(
	ctx: MutationCtx,
	mailMessageId: Id<'mailMessages'>,
	recipientIdx: number,
	input: TransitionInput
): Promise<TransitionOutcome> {
	const loaded = await loadRecipient(ctx, mailMessageId, recipientIdx);
	if (!('message' in loaded)) return loaded;
	const { message, recipients, recipient } = loaded;

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

	// Record the audit event after deriving the final aggregate.
	const auditEvent: PostboxOutboundAuditEvent = {
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
						...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
					}
				: {}),
		},
	};

	await recordPostboxOutboundAudit(ctx, auditEvent);

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

/**
 * Persist authenticated remote-DATA acceptance independently from recipient
 * display state. Timestamp order decides whether terminal state contradicts
 * the evidence; webhook arrival order never does.
 */
async function observeRemoteAcceptance(
	ctx: MutationCtx,
	mailMessageId: Id<'mailMessages'>,
	recipientIdx: number,
	acceptedAt: number
): Promise<TransitionOutcome> {
	const loaded = await loadRecipient(ctx, mailMessageId, recipientIdx);
	if (!('message' in loaded)) return loaded;
	const { message, recipients, recipient } = loaded;
	const aggregateBefore = message.outbound.state;

	if (!canAttributeRemoteAcceptance(recipient, acceptedAt)) {
		return {
			ok: false,
			reason: 'terminal',
			mailMessageId,
			recipientIdx,
			from: recipient.state,
			to: 'sent',
		};
	}

	const isFirstObservation = recipient.acceptedAt === undefined;
	const advancesDisplayState = recipient.state === 'queued';
	const updatedRecipient: RecipientRow = {
		...recipient,
		...(isFirstObservation ? { acceptedAt } : {}),
		...(advancesDisplayState ? { state: 'sent' as const, sentAt: acceptedAt } : {}),
	};
	const nextRecipients = recipients.map((candidate) =>
		candidate.idx === recipientIdx ? updatedRecipient : candidate
	);
	const aggregateAfter = advancesDisplayState
		? deriveAggregateState(nextRecipients)
		: aggregateBefore;

	if (isFirstObservation || advancesDisplayState) {
		await ctx.db.patch(mailMessageId, {
			outbound: { state: aggregateAfter, recipients: nextRecipients },
			updatedAt: Date.now(),
		});
	}
	if (advancesDisplayState) {
		await recordPostboxOutboundAudit(ctx, {
			mailMessageId,
			mailboxId: message.mailboxId,
			recipientIdx,
			from: recipient.state,
			to: 'sent',
			aggregateBefore,
			aggregateAfter,
			at: acceptedAt,
		});
	}

	return {
		ok: true,
		applied: isFirstObservation || advancesDisplayState ? 'transitioned' : 'recorded',
		mailMessageId,
		recipientIdx,
		from: recipient.state,
		to: 'sent',
		aggregateBefore,
		aggregateAfter,
	};
}

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
		return await dispatch(ctx, args.mailMessageId, args.recipientIdx, args.input);
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

export const observeRemoteAcceptanceByMtaMessageId = internalMutation({
	args: {
		rawProviderMessageId: v.string(),
		acceptedAt: v.number(),
	},
	handler: async (ctx, args): Promise<TransitionOutcome> => {
		const parsed = parsePostboxMtaId(args.rawProviderMessageId);
		if (!parsed) return { ok: false, reason: 'unknown_mta_id_prefix' };
		return await observeRemoteAcceptance(ctx, parsed.mailMessageId, parsed.idx, args.acceptedAt);
	},
});
