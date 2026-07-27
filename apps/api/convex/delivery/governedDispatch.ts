'use node';

import {
	GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
	MAX_GOVERNED_ROUTING_ATTEMPTS,
	type DeliveryDomain,
	type GovernedMessageType,
} from '@owlat/shared';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { sendProviderDispatch } from '../lib/sendProviders/dispatch';
import { defaultSendTransportId } from '../lib/sendProviders/transports';
import {
	type EmailSendParams,
	type ExtrasFor,
	type MtaExtras,
	type MtaIpPool,
	type ResendExtras,
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

type SendRef =
	| { kind: 'campaign'; id: Id<'emailSends'> }
	| { kind: 'transactional'; id: Id<'transactionalSends'> };

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
	sendRef?: SendRef;
	retryState?: WorkerRetryState;
	message: Omit<EmailSendParams, 'to' | 'from' | 'replyTo'>;
}

export type GovernedDispatchResult<TEnvelope> =
	| {
			success: true;
			providerMessageId: string;
			providerType: SendProviderKind;
			sendLatencyMs: number;
			/** MTA intake accepted the work; delivery remains queued until its webhook. */
			acceptedForDelivery?: true;
	  }
	| {
			success: false;
			deferred: true;
			retryAfterMs: number;
			envelopeInput: TEnvelope;
			retryState: WorkerRetryState;
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
		(request.sendRef ? `send_${request.sendRef.id}` : `legacy_${crypto.randomUUID()}`);
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
			envelopeInput: request.envelopeInput,
			// The attempt cap bounds routing churn. A deliberate safety hold is
			// not churn: consuming attempts would terminalize the send minutes
			// into a pause that is meant to outlast them, so a held message is
			// bounded by the delivery deadline instead.
			retryState: routing.isPolicyHold ? retryState : nextRetryState(retryState),
		};
	}

	const { providerKind, route, routingLease } = routing;
	if (providerKind === 'mta') {
		const binding = await ctx.runMutation(internal.delivery.sendLifecycle.bindMtaProviderIdentity, {
			send: request.sendRef,
			providerMessageId: idempotencyKey,
		});
		if (!binding.ok) throw new Error(`Unable to bind MTA provider identity: ${binding.reason}`);
	}
	const engagementScore = normalizeEngagementScore(request.engagementScore);
	const extras: ExtrasFor<SendProviderKind> =
		providerKind === 'mta'
			? ({
					messageId: idempotencyKey,
					workAttemptId,
					routingReentryToken: snapshot.token,
					routingReentry: {
						envelopeInput: request.envelopeInput,
						// Must equal the snapshot's retryState above — the callback
						// digest covers it.
						retryState: reentryRetryState(retryState),
					},
					organizationId,
					messageType: request.messageType,
					deliveryDomain: request.deliveryDomain,
					routingLease,
					allowWarmupOverflow: Boolean(
						request.messageType === 'campaign' && route?.warmupOverflowEnabled
					),
					...((route?.ipPool ?? request.ipPool)
						? { ipPool: (route?.ipPool ?? request.ipPool) as MtaIpPool }
						: {}),
					// Omitted, never zeroed, when the recipient has no score: the
					// MTA reads absence as "unknown" and applies its DEFAULT band,
					// whereas 0 would order the message behind every cold contact.
					...(engagementScore !== undefined ? { engagementScore } : {}),
				} satisfies MtaExtras)
			: providerKind === 'resend'
				? ({ idempotencyKey } satisfies ResendExtras)
				: {};
	const dispatched = await sendProviderDispatch(
		ctx,
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
			providerMessageId:
				providerKind === 'mta' && dispatched.result.id !== idempotencyKey
					? idempotencyKey
					: dispatched.result.id,
			providerType: dispatched.providerType,
			sendLatencyMs: dispatched.latencyMs,
			...(providerKind === 'mta' ? { acceptedForDelivery: true as const } : {}),
		};
	}
	if (dispatched.result.errorCode === 'ROUTING_DEFERRED') {
		return {
			success: false,
			deferred: true,
			retryAfterMs: dispatched.result.retryAfterMs ?? 60_000,
			envelopeInput: request.envelopeInput,
			retryState: nextRetryState(retryState),
		};
	}
	if (providerKind === 'mta' && dispatched.result.acceptanceUnknown) {
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

	throw new Error(dispatched.result.errorMessage || 'Unknown email sending error');
}
