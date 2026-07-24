import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import {
	legalEdgesFor,
	reduceBounced,
	reduceClicked,
	reduceComplained,
	reduceDelivered,
	reduceFailed,
	reduceOpened,
	reduceSent,
	type EmailSendDoc,
	type ReducerResult,
	type SendRef,
	type SendStatus,
	type TransactionalSendDoc,
	type TransitionInput,
	type TransitionOutcome,
} from './sendLifecycle/reducers';
import { applyEffects } from './sendLifecycle/effects';
import {
	canAttributeRemoteAcceptance,
	reduceDeliveryObservation,
	type DeliveryObservationResult,
} from './sendLifecycle/deliveryObservation';
import {
	contactEmailOf,
	loadSend,
	resolveProviderMessageId,
	resolveRecipientContact,
	senderDomainFor,
} from './sendLifecycle/lookups';
import { withoutTestSendEffects } from './sendLifecycle/types';
import { mirrorEmailSendWrite } from '../unifiedMessages';

// ============================================================================
// Send lifecycle — the single writer of `emailSends.status` and
// `transactionalSends.status`. See CONTEXT.md "Send lifecycle" for the domain
// vocabulary (Send, SendRef, Send status).
//
// This file is the DISPATCHER + the public mutation surface. The state graph,
// the 7 pure reducers and the legal-edges DAG live in `./sendLifecycle/reducers`
// (no `ctx`, directly unit-testable); the effect runner lives in
// `./sendLifecycle/effects`; the DB lookups (load/resolve/provenance) live in
// `./sendLifecycle/lookups`. Splitting per CONVENTIONS.md "Split only above
// ~500 LOC" — the reducer/runner boundary that already existed conceptually is
// now a file boundary.
//
// Public surface:
//   - transition({ send, transition })                — worker / direct path
//   - transitionByProviderMessageId({ providerMessageId, transition })
//                                                    — webhook path; resolves
//                                                       SendRef internally
//
// Both go through the same dispatcher. Reducers are pure-ish and return
// { patch, effects, applied } — the runner is the only place that touches the
// DB and the scheduler.
// ============================================================================

// Re-exported for external type consumers (`webhooks/dispatcher.ts` imports
// `TransitionOutcome` from this module path; the generated function paths stay
// `internal.delivery.sendLifecycle.*`).
export type {
	SendKind,
	SendRef,
	SendStatus,
	TransitionInput,
	TransitionOutcome,
} from './sendLifecycle/reducers';

// ─── Validators ─────────────────────────────────────────────────────────────

const sendRefValidator = v.union(
	v.object({ kind: v.literal('campaign'), id: v.id('emailSends') }),
	v.object({
		kind: v.literal('transactional'),
		id: v.id('transactionalSends'),
	})
);

const transitionInputValidator = v.union(
	v.object({
		to: v.literal('sent'),
		at: v.number(),
		providerMessageId: v.string(),
		providerType: v.optional(v.string()),
	}),
	v.object({
		to: v.literal('failed'),
		at: v.number(),
		errorMessage: v.string(),
		errorCode: v.string(),
	}),
	v.object({ to: v.literal('delivered'), at: v.number() }),
	v.object({ to: v.literal('opened'), at: v.number() }),
	v.object({ to: v.literal('clicked'), at: v.number(), url: v.string() }),
	v.object({
		to: v.literal('bounced'),
		at: v.number(),
		bounceType: v.union(v.literal('hard'), v.literal('soft')),
		bounceMessage: v.optional(v.string()),
	}),
	v.object({ to: v.literal('complained'), at: v.number() })
);

// ─── Dispatcher — the one place that fans transition kinds to reducers ─────

async function dispatch(
	ctx: MutationCtx,
	ref: SendRef,
	input: TransitionInput,
	options: { allowQueuedMtaTerminal?: boolean } = {}
): Promise<TransitionOutcome> {
	const send = await loadSend(ctx, ref);
	if (!send) return { ok: false, reason: 'send_not_found' };

	const from = send.status as SendStatus;
	// `legalEdgesFor` applies the soft-bounce exception: a soft-bounced row is
	// non-terminal (it may harden or draw a complaint), so its legal set is
	// `{bounced, complained}` rather than the empty static `bounced` set.
	const legalEdges = legalEdgesFor(send);
	const isBoundQueuedMtaTerminal =
		options.allowQueuedMtaTerminal === true &&
		from === 'queued' &&
		send.providerType === 'mta' &&
		(input.to === 'bounced' || input.to === 'complained' || input.to === 'failed');
	const isLegalEdge = legalEdges.has(input.to) || isBoundQueuedMtaTerminal;
	const isSelfLoop = from === input.to;
	const isDeliveryEvidence =
		input.to === 'delivered' ||
		input.to === 'opened' ||
		input.to === 'clicked' ||
		input.to === 'complained';
	// A late accepted-delivery event remains attributable when its authenticated
	// event time precedes a terminal transition. Arrival order never controls the
	// denominator; persisted terminal timestamps do.
	const isAttributableRemoteAcceptance =
		input.to === 'delivered' && canAttributeRemoteAcceptance(send, input.at);

	// Self-loops: `opened` / `clicked` re-fire as counter-only `recorded`
	// events, and `bounced → bounced` re-fire is routed to the reducer (which
	// decides duplicate vs. a soft-bounce counter bump vs. a soft → hard
	// hardening). All other self-loops report `duplicate` via the reducer; the
	// reducer also detects from === to and returns the duplicate outcome.
	if (!isLegalEdge && !isSelfLoop && !isAttributableRemoteAcceptance) {
		// Terminal states get a distinct reason for observability.
		if (legalEdges.size === 0) {
			return { ok: false, reason: 'terminal', from, to: input.to };
		}
		return { ok: false, reason: 'illegal_edge', from, to: input.to };
	}

	let deliveryObservation: DeliveryObservationResult = {
		patch: {},
		effects: [],
		isNewObservation: false,
	};
	let deliverySenderDomain: string | undefined;
	if (isDeliveryEvidence && send.deliveredAt === undefined) {
		deliverySenderDomain = await senderDomainFor(ctx, send, ref);
		const recipientContact = await resolveRecipientContact(ctx, send);
		const observationSend =
			isBoundQueuedMtaTerminal && input.to === 'complained'
				? ({ ...send, status: 'sent' } as typeof send)
				: send;
		deliveryObservation = reduceDeliveryObservation(
			observationSend,
			input.at,
			ref,
			deliverySenderDomain,
			recipientContact
		);
	}

	let result: ReducerResult;
	switch (input.to) {
		case 'sent': {
			const senderDomain = await senderDomainFor(ctx, send, ref);
			result = reduceSent(send, input, ref, senderDomain);
			break;
		}
		case 'failed':
			result = reduceFailed(send, input, ref);
			break;
		case 'delivered': {
			result = reduceDelivered(send, input);
			break;
		}
		case 'opened':
			result = reduceOpened(send, input, ref);
			break;
		case 'clicked':
			result = reduceClicked(send, input, ref);
			break;
		case 'bounced': {
			const senderDomain = await senderDomainFor(ctx, send, ref);
			const recipientContact = await resolveRecipientContact(ctx, send);
			result = reduceBounced(
				send,
				input,
				ref,
				contactEmailOf(send),
				senderDomain,
				recipientContact
			);
			break;
		}
		case 'complained': {
			const senderDomain = deliverySenderDomain ?? (await senderDomainFor(ctx, send, ref));
			result = reduceComplained(send, input, ref, contactEmailOf(send), senderDomain);
			break;
		}
	}

	result = withoutTestSendEffects(send, ref, {
		...result,
		patch: { ...deliveryObservation.patch, ...result.patch },
		effects: [...deliveryObservation.effects, ...result.effects],
		applied:
			deliveryObservation.isNewObservation && result.applied === 'duplicate'
				? 'recorded'
				: result.applied,
	});

	if (Object.keys(result.patch).length > 0) {
		// Per-kind narrowing for the patch call — Convex's patch signature is
		// table-specific.
		if (ref.kind === 'campaign') {
			await ctx.db.patch(ref.id, result.patch as Partial<EmailSendDoc>);
		} else {
			await ctx.db.patch(ref.id, result.patch as Partial<TransactionalSendDoc>);
		}
	}

	if (result.applied !== 'duplicate') {
		await applyEffects(ctx, result.effects);

		// Agent-reply source finalization belongs to the Send terminal edge, not
		// to one transport callback. Direct/relay completion and authenticated MTA
		// remote acceptance both pass here, while duplicate transitions remain a
		// no-op. This closes the approved-message state before the stale reconciler
		// can enqueue a second reply.
		if (
			ref.kind === 'transactional' &&
			(send as TransactionalSendDoc).kind === 'agent_reply' &&
			(send as TransactionalSendDoc).inboundMessageId &&
			(input.to === 'sent' ||
				input.to === 'failed' ||
				input.to === 'bounced' ||
				input.to === 'complained')
		) {
			const agentSend = send as TransactionalSendDoc;
			const succeeded = input.to === 'sent';
			await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
				inboundMessageId: agentSend.inboundMessageId!,
				input: succeeded
					? { to: 'sent', at: input.at }
					: {
							to: 'failed',
							at: input.at,
							errorMessage:
								input.to === 'failed'
									? input.errorMessage
									: input.to === 'bounced'
										? (input.bounceMessage ?? 'Delivery bounced')
										: 'Recipient complained about delivery',
						},
			});

			if (succeeded) {
				try {
					const inbound = await ctx.db.get(agentSend.inboundMessageId!);
					if (inbound?.threadId && agentSend.contactId) {
						await mirrorEmailSendWrite(ctx, {
							threadId: inbound.threadId,
							contactId: agentSend.contactId,
							subject: agentSend.subject,
							textBody: inbound.draftResponse,
							externalMessageId: input.providerMessageId,
							status: 'sent',
						});
					}
				} catch {
					// The timeline is a denormalized, idempotent read model. It must
					// never roll back the authoritative Send/source lifecycle edge.
				}
			}
		}

		// ── Post-send OUTCOME signal (graduated-autonomy learning) ──
		// A bounce or complaint on any agent reply (auto-sent OR human-approved)
		// is unambiguous negative feedback for the category/sender it was sent
		// under — a bad recipient address or spam complaint is a real negative
		// regardless of who pressed send — so record it for every agent_reply so
		// real-world delivery outcomes tune autonomy, not just the shrinking
		// human-reviewed subset (see agent/outcomeFeedback.ts). Fail-soft:
		// scheduled out-of-band so a learning-loop failure can never roll back
		// the delivery state transition. Only for genuinely new transitions.
		if ((input.to === 'bounced' || input.to === 'complained') && ref.kind === 'transactional') {
			const tSend = send as TransactionalSendDoc;
			if (tSend.kind === 'agent_reply' && tSend.inboundMessageId) {
				await ctx.scheduler.runAfter(0, internal.autonomyOutcome.recordOutcomeFeedback, {
					inboundMessageId: tSend.inboundMessageId,
					signal: input.to === 'bounced' ? 'bounce' : 'complaint',
				});
			}
		}

		// Reconcile at the authoritative lifecycle edge, including terminal MTA
		// webhooks that arrive after the workpool's intake callback returned.
		if (ref.kind === 'campaign' && from === 'queued') {
			await ctx.runMutation(internal.campaigns.lifecycle.reconcileCampaignCompletion, {
				campaignId: (send as EmailSendDoc).campaignId,
			});
		}
	}

	return {
		ok: true,
		applied: result.applied,
		from: result.from,
		to: result.to,
		contactEmail: contactEmailOf(send),
	};
}

// ─── Public mutations ───────────────────────────────────────────────────────

/**
 * Apply a state transition to a Send identified by SendRef. The only writer
 * of `emailSends.status` and `transactionalSends.status`.
 *
 * Atomic with: row patch, kind-specific side effects (blocklist, campaign
 * stats, contact activity, content-scan feedback) and customer-webhook
 * fanout scheduling. The scheduled fanout commits or rolls back with this
 * mutation.
 *
 * Duplicate / illegal / terminal / kind-mismatched transitions are reported
 * via TransitionOutcome — never thrown. Webhook adapters must not 5xx.
 */
export const transition = internalMutation({
	args: { send: sendRefValidator, transition: transitionInputValidator },
	handler: async (ctx, args): Promise<TransitionOutcome> => {
		return await dispatch(ctx, args.send, args.transition);
	},
});

/**
 * Same as `transition`, but the caller has a `providerMessageId` (from a
 * provider webhook) rather than a SendRef. Resolves the SendRef internally
 * (scanning emailSends first, then transactionalSends).
 *
 * Returns `{ ok: false, reason: 'send_not_found' }` for unknown ids — webhook
 * retries for sends that no longer exist should ack quietly.
 */
export const transitionByProviderMessageId = internalMutation({
	args: {
		providerMessageId: v.string(),
		transition: transitionInputValidator,
	},
	handler: async (ctx, args): Promise<TransitionOutcome> => {
		const ref = await resolveProviderMessageId(ctx, args.providerMessageId);
		if (!ref) return { ok: false, reason: 'send_not_found' };
		return await dispatch(ctx, ref, args.transition);
	},
});

/** Bind the deterministic MTA identity before crossing the network boundary. */
export const bindMtaProviderIdentity = internalMutation({
	args: { send: sendRefValidator, providerMessageId: v.string() },
	handler: async (ctx, args) => {
		const send = await loadSend(ctx, args.send);
		if (!send) return { ok: false as const, reason: 'send_not_found' as const };
		if (
			send.providerType === 'mta' &&
			send.providerMessageId &&
			send.providerMessageId !== args.providerMessageId
		) {
			return { ok: false as const, reason: 'identity_conflict' as const };
		}
		if (send.status !== 'queued') {
			return { ok: false as const, reason: 'terminal' as const };
		}
		if (!send.providerMessageId || send.providerType !== 'mta') {
			await ctx.db.patch(args.send.id, {
				providerMessageId: args.providerMessageId,
				providerType: 'mta',
			});
		}
		return { ok: true as const };
	},
});

/** Apply an authenticated terminal MTA result to its pre-bound provisional Send. */
export const transitionMtaByProviderMessageId = internalMutation({
	args: { providerMessageId: v.string(), transition: transitionInputValidator },
	handler: async (ctx, args): Promise<TransitionOutcome> => {
		const ref = await resolveProviderMessageId(ctx, args.providerMessageId);
		if (!ref) return { ok: false, reason: 'send_not_found' };
		const send = await loadSend(ctx, ref);
		if (!send || send.providerType !== 'mta' || send.providerMessageId !== args.providerMessageId) {
			return { ok: false, reason: 'send_not_found' };
		}
		return await dispatch(ctx, ref, args.transition, { allowQueuedMtaTerminal: true });
	},
});

/** Atomically record an MTA's remote SMTP acceptance as sent then delivered. */
export const recordMtaRemoteAcceptance = internalMutation({
	args: { providerMessageId: v.string(), at: v.number() },
	handler: async (ctx, args): Promise<TransitionOutcome> => {
		const ref = await resolveProviderMessageId(ctx, args.providerMessageId);
		if (!ref) return { ok: false, reason: 'send_not_found' };
		const send = await loadSend(ctx, ref);
		if (!send || send.providerType !== 'mta' || send.providerMessageId !== args.providerMessageId) {
			return { ok: false, reason: 'send_not_found' };
		}
		await dispatch(ctx, ref, {
			to: 'sent',
			at: args.at,
			providerMessageId: args.providerMessageId,
			providerType: 'mta',
		});
		// Delivery evidence can arrive after a later bounce/failure. The delivered
		// reducer owns timestamp attribution in that case; never let the synthetic
		// sent edge suppress an otherwise attributable observation.
		return await dispatch(ctx, ref, { to: 'delivered', at: args.at });
	},
});
