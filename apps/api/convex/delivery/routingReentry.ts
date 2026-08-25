import { v } from 'convex/values';
import {
	admitGovernedRetry,
	governedDeliveryDeadlineAt,
	ROUTING_REENTRY_TOKEN_TTL_MS,
} from '@owlat/shared';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { internalMutation, type MutationCtx } from '../_generated/server';
import {
	callbackDigest,
	decryptToken,
	encryptToken,
	type RoutingReentryTokenPayload,
} from './routingReentryToken';
import type { SendRef } from './sendLifecycle/types';
import { campaignEmailPool, transactionalEmailPool } from './workpool';
import {
	envelopeInputValidator,
	retryStateValidator,
	type WorkerEnvelopeInput,
	type WorkerRetryState,
} from './workerEnvelope';

export const sendRefValidator = v.union(
	v.object({ kind: v.literal('campaign'), id: v.id('emailSends') }),
	v.object({ kind: v.literal('transactional'), id: v.id('transactionalSends') })
);

/**
 * A deliverability SEED PROBE's durable reference (D18). A shadow copy has no
 * `emailSends` row — that is what keeps it out of every denominator — but its
 * probe-ledger row IS durable, org-scoped and unique, which is what the
 * governed boundary needs for an idempotency key and a re-entry token.
 * Deliberately outside `SendRef`: no lifecycle, no completion, no stat shard.
 */
export const seedProbeRefValidator = v.object({
	kind: v.literal('seedProbe'),
	id: v.id('seedPlacementProbes'),
});

/** Everything the governed dispatch boundary can issue a re-entry token for. */
export const reentryRefValidator = v.union(sendRefValidator, seedProbeRefValidator);

/** Issue a self-contained authenticated callback token after verifying its exact Send. */
export const issueSnapshot = internalMutation({
	args: {
		sendRef: reentryRefValidator,
		organizationId: v.string(),
		messageId: v.string(),
		workAttemptId: v.string(),
		envelopeInput: envelopeInputValidator,
		retryState: retryStateValidator,
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		// A token is only worth issuing while the message it re-enters is still
		// inside its cumulative deadline. Only the deadline arm: the attempt cap is
		// the dispatch boundary's to refuse, and it already has.
		if (admitGovernedRetry(args.retryState, now).deadline !== 'ok') {
			throw new Error('Routing re-entry deadline expired.');
		}
		if (args.sendRef.kind === 'seedProbe') {
			// A seed probe is bound to its ledger row, not to a Send. The binding
			// checked here is the one the probe header carries.
			const probe = await ctx.db.get(args.sendRef.id);
			if (!probe) throw new Error('Routing re-entry token requires an existing seed probe.');
			// EITHER envelope kind can carry a probe: the campaign shadow copy
			// measures the `campaign` cell, the scheduled probe measures the other
			// two through the transactional envelope. What is asserted is the same
			// on both — the header's id is this ledger row's, and the envelope
			// carries no countable Send id of its own kind.
			const countableSendId =
				args.envelopeInput.kind === 'campaign'
					? args.envelopeInput.emailSendId
					: args.envelopeInput.sendId;
			if (args.envelopeInput.seedProbeId !== probe.probeId || countableSendId !== undefined) {
				throw new Error('Routing re-entry envelope does not belong to the seed probe.');
			}
			if (probe.organizationId !== args.organizationId) {
				throw new Error('Routing re-entry probe does not belong to the organization.');
			}
		} else {
			const send = await ctx.db.get(args.sendRef.id);
			if (!send || send.status !== 'queued') {
				throw new Error('Routing re-entry token requires an existing queued Send.');
			}
			if (
				(args.envelopeInput.kind === 'campaign' &&
					(args.sendRef.kind !== 'campaign' ||
						args.envelopeInput.emailSendId !== args.sendRef.id)) ||
				(args.envelopeInput.kind === 'transactional' &&
					(args.sendRef.kind !== 'transactional' || args.envelopeInput.sendId !== args.sendRef.id))
			) {
				throw new Error('Routing re-entry envelope does not belong to the Send.');
			}
		}
		if (args.envelopeInput.organizationId !== args.organizationId) {
			throw new Error('Routing re-entry envelope does not belong to the organization.');
		}
		const expiresAt = Math.min(
			now + ROUTING_REENTRY_TOKEN_TTL_MS,
			governedDeliveryDeadlineAt(args.retryState.startedAt)
		);
		const token = await encryptToken({
			sendKind: args.sendRef.kind,
			sendId: args.sendRef.id,
			organizationId: args.organizationId,
			messageId: args.messageId,
			workAttemptId: args.workAttemptId,
			attempt: args.retryState.attempt,
			expiresAt,
			callbackDigest: await callbackDigest(args.envelopeInput, args.retryState),
		});
		return { token, expiresAt };
	},
});

type ReentrySend = Doc<'emailSends'> | Doc<'transactionalSends'>;

interface ReentryTarget {
	sendRef: SendRef;
	send: ReentrySend;
	recordAttempt(): Promise<void>;
	enqueue(): Promise<void>;
}

type TargetResolution =
	| { ok: true; target: ReentryTarget }
	| { ok: false; disposition: 'binding_mismatch' | 'snapshot_not_found' };

/**
 * Resolve the token's table-specific Send once, then expose typed closures for
 * the only operations that differ between campaign and transactional rows.
 * The caller owns the shared lifecycle/CAS/deadline state machine.
 */
async function resolveReentryTarget(
	ctx: MutationCtx,
	payload: RoutingReentryTokenPayload,
	envelopeInput: WorkerEnvelopeInput,
	retryState: WorkerRetryState,
	messageId: string
): Promise<TargetResolution> {
	// A seed probe is DISPOSABLE by design: no lifecycle to resume and no
	// denominator that would notice its absence, so a hand-back is dropped. Its
	// ledger row stays unclassified, and unclassified probes are not evidence.
	if (payload.sendKind === 'seedProbe') {
		return { ok: false, disposition: 'snapshot_not_found' };
	}
	if (payload.sendKind === 'campaign') {
		const id = ctx.db.normalizeId('emailSends', payload.sendId);
		if (!id || envelopeInput.kind !== 'campaign' || envelopeInput.emailSendId !== id) {
			return { ok: false, disposition: 'binding_mismatch' };
		}
		const send = await ctx.db.get(id);
		if (!send) return { ok: false, disposition: 'snapshot_not_found' };
		return {
			ok: true,
			target: {
				sendRef: { kind: 'campaign', id },
				send,
				recordAttempt: async () => {
					await ctx.db.patch(id, {
						mtaRoutingReentryAttempt: payload.attempt,
						...(!send.providerMessageId
							? { providerMessageId: messageId, providerType: 'mta' }
							: {}),
					});
				},
				enqueue: async () => {
					await campaignEmailPool.enqueueAction(
						ctx,
						internal.delivery.worker.sendSingleEmail,
						{ envelopeInput, retryState },
						{
							onComplete: internal.delivery.sendCompletion.completeSend,
							context: { sendRef: { kind: 'campaign', id } },
						}
					);
				},
			},
		};
	}

	const id = ctx.db.normalizeId('transactionalSends', payload.sendId);
	if (!id || envelopeInput.kind !== 'transactional' || envelopeInput.sendId !== id) {
		return { ok: false, disposition: 'binding_mismatch' };
	}
	const send = await ctx.db.get(id);
	if (!send) return { ok: false, disposition: 'snapshot_not_found' };
	return {
		ok: true,
		target: {
			sendRef: { kind: 'transactional', id },
			send,
			recordAttempt: async () => {
				await ctx.db.patch(id, {
					mtaRoutingReentryAttempt: payload.attempt,
					...(!send.providerMessageId ? { providerMessageId: messageId, providerType: 'mta' } : {}),
				});
			},
			enqueue: async () => {
				await transactionalEmailPool.enqueueAction(
					ctx,
					internal.delivery.worker.sendSingleEmail,
					{ envelopeInput, retryState },
					{
						onComplete: internal.delivery.sendCompletion.completeSend,
						context: { sendRef: { kind: 'transactional', id } },
					}
				);
			},
		},
	};
}

/** Decrypt, bind, and atomically advance the persisted attempt marker before enqueue. */
export const consumeSnapshot = internalMutation({
	args: {
		token: v.string(),
		messageId: v.string(),
		workAttemptId: v.string(),
		reason: v.union(
			v.literal('routing_lease_stale'),
			v.literal('circuit_breaker_changed'),
			v.literal('warming_capacity_changed')
		),
		envelopeInput: envelopeInputValidator,
		retryState: retryStateValidator,
	},
	handler: async (ctx, args) => {
		const payload = await decryptToken(args.token);
		if (!payload) return { disposition: 'invalid_token' as const };
		if (
			payload.messageId !== args.messageId ||
			payload.workAttemptId !== args.workAttemptId ||
			payload.attempt !== args.retryState.attempt ||
			payload.callbackDigest !== (await callbackDigest(args.envelopeInput, args.retryState)) ||
			args.retryState.idempotencyKey !== args.messageId ||
			args.envelopeInput.organizationId !== payload.organizationId
		) {
			return { disposition: 'binding_mismatch' as const };
		}
		const now = Date.now();
		// THE WHOLE BUDGET, DECIDED ONCE — but acted on at two different points,
		// which is why the arms are read separately rather than through the
		// collapsed `admission`. The deadline terminalizes the Send (below, after
		// the row is bound and proven still queued), while the attempt cap may only
		// terminalize AFTER the attempt marker has advanced, or a replayed callback
		// would re-run the same terminal write. An age that is negative or
		// unreadable is a token whose clock does not describe this Send: refused as
		// a binding mismatch, never as an expiry.
		const budget = admitGovernedRetry(
			{ attempt: payload.attempt, startedAt: args.retryState.startedAt },
			now
		);
		if (budget.deadline === 'clock_reversed' || budget.deadline === 'clock_unreadable') {
			return { disposition: 'binding_mismatch' as const };
		}
		const deadlineExpired = budget.deadline === 'deadline_expired';
		if (!deadlineExpired && payload.expiresAt <= now) return { disposition: 'expired' as const };

		const resolution = await resolveReentryTarget(
			ctx,
			payload,
			args.envelopeInput,
			args.retryState,
			args.messageId
		);
		if (!resolution.ok) return { disposition: resolution.disposition };
		const { sendRef, send, recordAttempt, enqueue } = resolution.target;
		if (send.status !== 'queued') return { disposition: 'terminal' as const };
		if (send.providerMessageId && send.providerMessageId !== args.messageId) {
			return { disposition: 'message_mismatch' as const };
		}
		if (deadlineExpired) {
			await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
				send: sendRef,
				transition: {
					to: 'failed',
					at: now,
					errorCode: 'DELIVERY_DEADLINE_EXPIRED',
					errorMessage: 'Delivery exceeded the cumulative four-day routing deadline.',
				},
			});
			return { disposition: 'deadline_expired' as const };
		}
		if ((send.mtaRoutingReentryAttempt ?? 0) >= payload.attempt) {
			return { disposition: 'duplicate' as const };
		}
		await recordAttempt();
		if (budget.attempts === 'attempt_capped') {
			await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
				send: sendRef,
				transition: {
					to: 'failed',
					at: now,
					errorCode: 'ROUTING_RETRY_EXHAUSTED',
					errorMessage: 'Delivery routing changed after the final bounded attempt.',
				},
			});
			return { disposition: 'retry_exhausted' as const };
		}
		await enqueue();
		return { disposition: 'enqueued' as const, reason: args.reason };
	},
});
