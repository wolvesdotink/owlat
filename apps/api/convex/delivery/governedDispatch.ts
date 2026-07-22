'use node';

import type { GovernedMessageType } from '@owlat/shared';
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

export interface WorkerRetryState {
	attempt: number;
	startedAt: number;
	idempotencyKey: string;
}

interface GovernedDispatchRequest<TEnvelope> {
	envelopeInput: TEnvelope;
	messageType: GovernedMessageType;
	to: string;
	from: string;
	replyTo?: string;
	providerType?: string;
	ipPool?: string;
	organizationId?: string;
	stableSendId?: string;
	retryState?: WorkerRetryState;
	message: Omit<EmailSendParams, 'to' | 'from' | 'replyTo'>;
}

export type GovernedDispatchResult<TEnvelope> =
	| {
			success: true;
			providerMessageId: string;
			providerType: SendProviderKind;
			sendLatencyMs: number;
	  }
	| {
			success: false;
			deferred: true;
			retryAfterMs: number;
			envelopeInput: TEnvelope;
			retryState: WorkerRetryState;
	  };

function nextRetryState(
	retryState: WorkerRetryState | undefined,
	idempotencyKey: string
): WorkerRetryState {
	return {
		attempt: (retryState?.attempt ?? 0) + 1,
		startedAt: retryState?.startedAt ?? Date.now(),
		idempotencyKey,
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
		(request.stableSendId ? `send_${request.stableSendId}` : `legacy_${crypto.randomUUID()}`);
	const routing = await resolveLastMileRouting(ctx, {
		messageType: request.messageType,
		to: request.to,
		from: request.from,
		providerType: request.providerType,
		ipPool: request.ipPool,
		organizationId: request.organizationId,
		idempotencyKey,
	});
	if (routing.kind === 'defer') {
		return {
			success: false,
			deferred: true,
			retryAfterMs: routing.retryAfterMs,
			envelopeInput: request.envelopeInput,
			retryState: nextRetryState(request.retryState, idempotencyKey),
		};
	}

	const { providerKind, route, organizationId, routingLease } = routing;
	const routingRetryState = nextRetryState(request.retryState, idempotencyKey);
	const extras: ExtrasFor<SendProviderKind> =
		providerKind === 'mta'
			? ({
					messageId: idempotencyKey,
					organizationId,
					messageType: request.messageType,
					routingLease,
					allowWarmupOverflow: Boolean(
						request.messageType === 'campaign' && route?.warmupOverflowEnabled
					),
					...(request.stableSendId
						? {
								routingReentry: {
									sendRef: {
										kind:
											request.messageType === 'campaign'
												? ('campaign' as const)
												: ('transactional' as const),
										id: request.stableSendId,
									},
									envelopeInput: request.envelopeInput,
									retryState: routingRetryState,
								},
							}
						: {}),
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
		};
	}
	if (dispatched.result.errorCode === 'ROUTING_DEFERRED') {
		return {
			success: false,
			deferred: true,
			retryAfterMs: dispatched.result.retryAfterMs ?? 60_000,
			envelopeInput: request.envelopeInput,
			retryState: routingRetryState,
		};
	}

	throw new Error(dispatched.result.errorMessage || 'Unknown email sending error');
}
