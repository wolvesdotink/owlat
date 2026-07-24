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
import {
	type EmailSendParams,
	type ExtrasFor,
	type MtaExtras,
	type MtaIpPool,
	type ResendExtras,
	type SendProviderKind,
} from '../lib/sendProviders';
import { resolveLastMileRouting } from './lastMileRouting';
import type { WorkerEnvelopeInput } from './workerEnvelope';
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
		retryState: nextRetryState(retryState),
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
			retryState: nextRetryState(retryState),
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
	const extras: ExtrasFor<SendProviderKind> =
		providerKind === 'mta'
			? ({
					messageId: idempotencyKey,
					workAttemptId,
					routingReentryToken: snapshot.token,
					routingReentry: {
						envelopeInput: request.envelopeInput,
						retryState: nextRetryState(retryState),
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
				} satisfies MtaExtras)
			: providerKind === 'resend'
				? ({ idempotencyKey } satisfies ResendExtras)
				: {};
	const dispatched = await sendProviderDispatch(
		ctx,
		providerKind,
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
