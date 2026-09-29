import { internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import type { SendRef } from './sendLifecycle/types';
import { campaignEmailPool, transactionalEmailPool } from './workpool';
import type { WorkerEnvelopeInput, WorkerRetryState } from './workerEnvelope';

/**
 * Governed enqueue — the one place that hands mail to the send worker
 * (`internal.delivery.worker.sendSingleEmail`).
 *
 * The pools themselves are configured in `delivery/workpool.ts`. This module
 * sits beside them rather than inside them because tests replace
 * `delivery/workpool` wholesale with stub pools; keeping the seam in its own
 * module means those tests still run the real wiring below and assert on what
 * it passes to `enqueueAction`.
 *
 * `__tests__/governedEnqueueSeam.test.ts` fails if any other module names the
 * worker, so a new producer has to come through one of the two functions here.
 */

/**
 * THE governed enqueue seam: the only place that hands a countable Send to
 * `internal.delivery.worker.sendSingleEmail`. Every Send has a row created in
 * `queued` before this runs, and per ADR-0006 its completion is owned by the
 * Send completion (module) — so the `onComplete` callback and the `sendRef`
 * context are wired HERE, once, rather than by each producer. A producer that
 * forgot either would leave its row `queued` forever with nothing to close it.
 *
 * The pool follows the Send's table: campaign rows go through the bulk
 * `campaignEmailPool`, transactional rows (API sends, automation steps, agent
 * replies, test previews) through the higher-priority `transactionalEmailPool`.
 * `retryState` is present only when the Send re-enters the pool after a
 * governed deferral or a routing re-entry.
 */
export async function enqueueGovernedSend(
	ctx: MutationCtx,
	sendRef: SendRef,
	args: { envelopeInput: WorkerEnvelopeInput; retryState?: WorkerRetryState }
): Promise<void> {
	const pool = sendRef.kind === 'campaign' ? campaignEmailPool : transactionalEmailPool;
	await pool.enqueueAction(
		ctx,
		internal.delivery.worker.sendSingleEmail,
		{
			envelopeInput: args.envelopeInput,
			...(args.retryState !== undefined ? { retryState: args.retryState } : {}),
		},
		{
			onComplete: internal.delivery.sendCompletion.completeSend,
			context: { sendRef },
		}
	);
}

/**
 * Enqueue a deliverability SEED PROBE: the campaign shadow copy
 * (`delivery/seedShadowCopy.ts`) or a scheduled stream probe
 * (`delivery/seedScheduledProbe.ts`). A probe has no Send row — that is what
 * keeps it out of every denominator (D18) — so there is no `SendRef` to carry
 * and no completion owner (ADR-0006): it is enqueued WITHOUT `onComplete`, on
 * purpose. Its durable record is the `seedPlacementProbes` ledger row, which
 * the placement poller classifies later.
 *
 * `pool` is the pool of the stream being measured, so the probe waits in the
 * same queue as the mail it stands in for.
 */
export async function enqueueUntrackedProbe(
	ctx: MutationCtx,
	pool: 'campaign' | 'transactional',
	envelopeInput: WorkerEnvelopeInput
): Promise<void> {
	const workpool = pool === 'campaign' ? campaignEmailPool : transactionalEmailPool;
	await workpool.enqueueAction(ctx, internal.delivery.worker.sendSingleEmail, { envelopeInput });
}
