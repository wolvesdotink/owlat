'use node';

import {
	GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
	MAX_GOVERNED_ROUTING_ATTEMPTS,
	type DeliveryDomain,
	type GovernedMessageType,
} from '@owlat/shared';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import {
	acceptanceSemanticsFor,
	hasProviderFeedbackFor,
	messageIdSourceFor,
	preassignsProviderMessageId,
	takesCustodyOnAcceptance,
} from '../lib/sendProviders/catalog';
import { sendProviderDispatch } from '../lib/sendProviders/dispatch';
import { defaultSendTransportId } from '../lib/sendProviders/transports';
import {
	buildDispatchExtrasFor,
	type EmailSendParams,
	type SendProviderKind,
} from '../lib/sendProviders';
import { resolveLastMileRouting } from './lastMileRouting';
import { normalizeEngagementScore, type WorkerEnvelopeInput } from './workerEnvelope';
import type { Id } from '../_generated/dataModel';

export interface WorkerRetryState {
	attempt: number;
	startedAt: number;
	idempotencyKey: string;
	workAttemptId?: string;
	acceptanceReconciliation?: boolean;
}

/**
 * The durable reference this dispatch is bound to.
 *
 * `campaign` / `transactional` are countable Sends with a full lifecycle.
 * `seedProbe` is a deliverability shadow copy (D18): durable (its probe-ledger
 * row), org-scoped and unique, but deliberately NOT a Send — no `emailSends`
 * row, no completion handler, no stat shard, no reputation event. It is
 * accepted here so the probe travels the IDENTICAL transport as the mail it
 * measures instead of a parallel one.
 */
type DispatchRef =
	| { kind: 'campaign'; id: Id<'emailSends'> }
	| { kind: 'transactional'; id: Id<'transactionalSends'> }
	| { kind: 'seedProbe'; id: Id<'seedPlacementProbes'> };

interface GovernedDispatchRequest<TEnvelope> {
	envelopeInput: TEnvelope;
	deliveryDomain: DeliveryDomain;
	messageType: GovernedMessageType;
	to: string;
	from: string;
	replyTo?: string;
	providerType?: string;
	ipPool?: string;
	organizationId?: string;
	/**
	 * Recipient engagement score (0-100) carried on the send envelope. Stamped
	 * onto `MtaExtras` for the MTA's enqueue-time priority bands. `undefined`
	 * (unscored contact, or no contact at all) is OMITTED from the extras — it
	 * is not `0`, which would claim the recipient is cold.
	 */
	engagementScore?: number;
	sendRef?: DispatchRef;
	retryState?: WorkerRetryState;
	message: Omit<EmailSendParams, 'to' | 'from' | 'replyTo'>;
}

export type GovernedDispatchResult<TEnvelope> =
	| {
			success: true;
			providerMessageId: string;
			providerType: SendProviderKind;
			sendLatencyMs: number;
			/**
			 * The transport took CUSTODY of the message rather than delivering it
			 * (its catalog entry declares `acceptanceSemantics: 'accepted'`):
			 * intake accepted the work and delivery remains queued until the
			 * transport's own feedback terminalizes the Send.
			 */
			acceptedForDelivery?: true;
	  }
	| {
			success: false;
			deferred: true;
			retryAfterMs: number;
			envelopeInput: TEnvelope;
			retryState: WorkerRetryState;
			/**
			 * Carried to the completion callback because that is where gate 2's
			 * numerator is written and the routing result is long gone by then. See
			 * `LastMileRoutingDeferred.origin`: only `governed` is evidence about this
			 * sending identity, and only `governed` is counted.
			 */
			deferralOrigin: 'governed' | 'local';
	  }
	| {
			success: false;
			acceptanceUnknown: true;
			providerMessageId: string;
			workAttemptId: string;
			startedAt: number;
			envelopeInput: TEnvelope;
			retryState: WorkerRetryState;
			retryAfterMs?: number;
	  }
	/**
	 * ACCEPTANCE IS OPEN AND CANNOT BE RE-ASKED (plan D4).
	 *
	 * The custody arm above (`acceptanceSemantics: 'accepted'`) reconciles by
	 * REPLAYING the attempt: its idempotency key IS the transport's message id, so
	 * a repeat dispatch either finds the existing work or creates it, and no
	 * recipient can be mailed twice. A relay that has no idempotency surface —
	 * Mandrill's `send-raw` has none — offers no such question. The lost response
	 * may sit on top of an ACCEPTED and DELIVERED message, so this arm carries no
	 * envelope and no message id: there is deliberately nothing here a caller
	 * could re-dispatch from.
	 *
	 * What it asks the completion callback for is a PARK, not a retry: keep the
	 * Send `queued` — the state that says "we do not know yet", which is the
	 * truth — until the delivery deadline, then terminalize with a code that says
	 * so. `queued` is also the only state a later transition can still leave;
	 * `failed` is terminal in `LEGAL_EDGES`, so the shipped behaviour (falling
	 * through to `throw` → `WORKPOOL_FAILED`) closed the row against every piece
	 * of evidence that could still arrive AND claimed a definite non-delivery for
	 * a message that may well have been delivered.
	 */
	| {
			success: false;
			acceptanceUnknown: true;
			awaitingProviderFeedback: true;
			providerType: SendProviderKind;
			startedAt: number;
			retryState: WorkerRetryState;
	  };

function currentRetryState(
	retryState: WorkerRetryState | undefined,
	idempotencyKey: string
): WorkerRetryState {
	return {
		...retryState,
		attempt: retryState?.attempt ?? 1,
		startedAt: retryState?.startedAt ?? Date.now(),
		idempotencyKey,
	};
}

function nextRetryState(current: WorkerRetryState): WorkerRetryState {
	return { ...current, attempt: current.attempt + 1 };
}

/**
 * The retry state a routing re-entry successor inherits.
 *
 * A successor is a NEW work attempt and must mint its own `workAttemptId`.
 * Inheriting the current one would make the successor's `POST /send` dedupe
 * against the intake receipt of the very job that surrendered ownership: the
 * MTA answers `deduplicated: true`, Convex records the Send as accepted for
 * delivery, and no MTA work exists — the Send waits `queued` for a terminal
 * webhook that can never arrive, and the message is never delivered.
 *
 * `acceptanceReconciliation` is dropped for the same reason it was set: it
 * marks acceptance as *unknown*, and a re-entry handoff always happens before
 * SMTP, which proves that attempt did not deliver. The successor is an
 * ordinary governed attempt again.
 *
 * Both the issued snapshot and the MTA-facing copy must use this, or the
 * callback digest stops matching.
 */
function reentryRetryState(current: WorkerRetryState): WorkerRetryState {
	const next = nextRetryState(current);
	return {
		attempt: next.attempt,
		startedAt: next.startedAt,
		idempotencyKey: next.idempotencyKey,
	};
}

/**
 * Resolve the authoritative last-mile route and dispatch one composed message.
 *
 * This boundary owns the stable idempotency key, governed routing lease, MTA
 * route extras, and both pre-dispatch and provider-side deferral shapes. The
 * worker remains responsible for suppression, composition, and attachments.
 */
export async function dispatchGovernedEmail<TEnvelope>(
	ctx: ActionCtx,
	request: GovernedDispatchRequest<TEnvelope>
): Promise<GovernedDispatchResult<TEnvelope>> {
	const idempotencyKey =
		request.retryState?.idempotencyKey ??
		(request.sendRef
			? `${request.sendRef.kind === 'seedProbe' ? 'probe' : 'send'}_${request.sendRef.id}`
			: `legacy_${crypto.randomUUID()}`);
	const retryState = currentRetryState(request.retryState, idempotencyKey);
	if (retryState.attempt > MAX_GOVERNED_ROUTING_ATTEMPTS) {
		throw new Error('Governed delivery retry limit exhausted.');
	}
	const ageMs = Date.now() - retryState.startedAt;
	if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= GOVERNED_MTA_MAX_MESSAGE_AGE_MS) {
		throw new Error('Governed delivery deadline expired.');
	}
	const organizationId =
		request.organizationId ??
		(await ctx.runQuery(internal.campaigns.sendQueries.getSingletonOrganizationId, {}));
	if (!organizationId)
		throw new Error('Delivery safety decision requires an organization identity.');
	if (!request.sendRef) throw new Error('Governed MTA delivery requires a durable Send reference.');
	const workAttemptId = retryState.workAttemptId ?? crypto.randomUUID();
	const snapshot = await ctx.runMutation(internal.delivery.routingReentry.issueSnapshot, {
		sendRef: request.sendRef,
		organizationId,
		messageId: idempotencyKey,
		workAttemptId,
		envelopeInput: request.envelopeInput as WorkerEnvelopeInput,
		retryState: reentryRetryState(retryState),
	});
	const routing = await resolveLastMileRouting(ctx, {
		messageType: request.messageType,
		to: request.to,
		from: request.from,
		providerType: request.providerType,
		ipPool: request.ipPool,
		organizationId,
		idempotencyKey,
		workAttemptId,
		routingReentryToken: snapshot.token,
		startedAt: retryState.startedAt,
		deliveryDomain: request.deliveryDomain,
		mtaReconciliation: retryState.acceptanceReconciliation === true,
		// The recorded experiment row is keyed by this id: dispatching on the
		// arm it names is what keeps the measured denominators honest.
		sendId: request.sendRef.id,
	});
	if (routing.kind === 'defer') {
		if (retryState.acceptanceReconciliation) {
			return {
				success: false,
				acceptanceUnknown: true,
				providerMessageId: idempotencyKey,
				workAttemptId,
				startedAt: retryState.startedAt,
				envelopeInput: request.envelopeInput,
				retryState,
				retryAfterMs: routing.retryAfterMs,
			};
		}
		return {
			success: false,
			deferred: true,
			retryAfterMs: routing.retryAfterMs,
			deferralOrigin: routing.origin,
			envelopeInput: request.envelopeInput,
			// The attempt cap bounds routing churn. A deliberate safety hold is
			// not churn: consuming attempts would terminalize the send minutes
			// into a pause that is meant to outlast them, so a held message is
			// bounded by the delivery deadline instead.
			retryState: routing.isPolicyHold ? retryState : nextRetryState(retryState),
		};
	}

	const { providerKind, route, routingLease, relayReturnPathHost } = routing;
	// A CAPABILITY, NOT A KIND (plan D2). Both facts below are declared by the
	// transport's catalog entry, so a new provider kind never edits this file:
	//   · does its provider message id exist before the send (ours, not theirs)?
	//   · does a successful dispatch mean CUSTODY rather than delivery?
	// Both halves are read the same way — the catalog's own predicate applied to
	// the catalog's own declaration — so neither question is ever spelled as a
	// bare comparison here, and a second consumer joins by calling the same pair.
	const providerMessageIdIsPreassigned = preassignsProviderMessageId(
		messageIdSourceFor(providerKind)
	);
	const transportTakesCustody = takesCustodyOnAcceptance(acceptanceSemanticsFor(providerKind));
	// Only a transport whose message id we minted ourselves can have an identity
	// bound BEFORE the network crossing — for anyone else the id does not exist
	// until the response carries it. Binding early is what lets a webhook that
	// races the send response still be attributed to this Send.
	//
	// A seed probe has no Send row to bind a provider identity to — binding is
	// the Send lifecycle's job, and a probe deliberately has no lifecycle (D18).
	if (providerMessageIdIsPreassigned && request.sendRef.kind !== 'seedProbe') {
		const binding = await ctx.runMutation(internal.delivery.sendLifecycle.bindMtaProviderIdentity, {
			send: request.sendRef,
			providerMessageId: idempotencyKey,
		});
		// THE LAST MTA-NAMED STRING HERE, AND IT IS NAMED FOR THE MUTATION ABOVE,
		// NOT FOR THE KIND: an operator who greps `bindMtaProviderIdentity` finds
		// this throw and vice versa. It moves WITH that rename — item 2 of the
		// PREREQUISITES note on `AcceptanceSemantics` in
		// `lib/sendProviders/catalogTypes.ts`, which is what a second kind declaring
		// `messageIdSource: 'idempotency-key'` must do before it can reach this
		// line at all. Renaming the string on its own would break that grep and
		// still leave the mutation stamping the own arm's kind onto the Send.
		if (!binding.ok) throw new Error(`Unable to bind MTA provider identity: ${binding.reason}`);
	}
	const engagementScore = normalizeEngagementScore(request.engagementScore);
	// The facts, not the shape: this boundary states what it knows about the send
	// and the provider module turns that into its own typed extras. No branch on
	// which provider — a new kind adds an adapter, never a case here.
	const extras = buildDispatchExtrasFor(providerKind, {
		idempotencyKey,
		workAttemptId,
		organizationId,
		messageType: request.messageType,
		deliveryDomain: request.deliveryDomain,
		routingReentryToken: snapshot.token,
		routingReentry: {
			envelopeInput: request.envelopeInput,
			// Must equal the snapshot's retryState above — the callback digest
			// covers it.
			retryState: reentryRetryState(retryState),
		},
		routingLease,
		ipPool: route?.ipPool ?? request.ipPool,
		warmupOverflowEnabled: route?.warmupOverflowEnabled,
		engagementScore,
		relayReturnPathHost,
	});
	const dispatched = await sendProviderDispatch(
		ctx,
		// The SAME instance the routing pass graded for return-path capability.
		defaultSendTransportId(providerKind),
		{
			to: request.to,
			from: request.from,
			replyTo: request.replyTo,
			...request.message,
		},
		extras
	);

	if (dispatched.result.success) {
		return {
			success: true,
			// A pre-assigned id is authoritative over whatever the response
			// carried: a deduplicated MTA intake answers a sentinel id, and
			// recording that would orphan the Send from every later report.
			providerMessageId: providerMessageIdIsPreassigned ? idempotencyKey : dispatched.result.id,
			providerType: dispatched.providerType,
			sendLatencyMs: dispatched.latencyMs,
			...(transportTakesCustody ? { acceptedForDelivery: true as const } : {}),
		};
	}
	if (dispatched.result.errorCode === 'ROUTING_DEFERRED') {
		return {
			success: false,
			deferred: true,
			retryAfterMs: dispatched.result.retryAfterMs ?? 60_000,
			// The MTA revalidated its own lease at enqueue and withdrew it
			// (`mtaSendProvider.categorizeError`) — its governance, not our fault.
			// OVER-BROAD, KNOWINGLY: the same 409 carries `ROUTING_DECISION_EXPIRED`,
			// which the MTA also answers when its Redis lost the lease record rather
			// than when the lease aged out, and that is our fault. Separating them
			// needs a distinction the MTA does not make on the wire, so this path
			// still spends gate 2's budget — issue #505 carries the wire change,
			// and `delivery/deferralOutcome.ts` says the same.
			deferralOrigin: 'governed',
			envelopeInput: request.envelopeInput,
			retryState: nextRetryState(retryState),
		};
	}
	if (dispatched.result.acceptanceUnknown) {
		// RE-ASKABLE, BY DECLARATION. A transport that takes custody under an
		// idempotency key we minted answers the same question twice without
		// mailing anyone twice, so the ambiguity is resolved by replaying the
		// attempt rather than by guessing (plan D4).
		if (transportTakesCustody) {
			return {
				success: false,
				acceptanceUnknown: true,
				providerMessageId: idempotencyKey,
				workAttemptId,
				startedAt: retryState.startedAt,
				envelopeInput: request.envelopeInput,
				retryState: {
					...retryState,
					workAttemptId,
					acceptanceReconciliation: true,
				},
			};
		}
		// A CAPABILITY, NOT A KIND LIST. The question a park is waiting on is
		// "could this transport still tell us what happened?", and the catalog
		// already answers it (`hasProviderFeedback`). A transport with no feedback
		// channel — a bring-your-own SMTP relay — has nothing to wait for, so its
		// ambiguity falls through to the throw below exactly as it does today.
		//
		// NOT A DEFERRAL, and deliberately not routed through one. An ambiguous
		// timeout is our own request outcome going missing, not a receiver holding
		// the message: borrowing the deferral shape would re-enqueue the send (D4
		// forbids it) and would put a non-observation into
		// `transportOutcomes.deferred`, whose two writers already measure from
		// different points on the delivery path (see the ruler-asymmetry note in
		// `delivery/deferralOutcome.ts`). Gate 2's numerator stays untouched here.
		if (hasProviderFeedbackFor(providerKind)) {
			return {
				success: false,
				acceptanceUnknown: true,
				awaitingProviderFeedback: true,
				providerType: dispatched.providerType,
				startedAt: retryState.startedAt,
				retryState,
			};
		}
	}

	throw new Error(dispatched.result.errorMessage || 'Unknown email sending error');
}
