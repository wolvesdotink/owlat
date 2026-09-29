/**
 * Guard: `delivery/governedEnqueue.ts` is the only module that hands mail to
 * the send worker.
 *
 * Seven producers used to wire `enqueueAction(ctx, sendSingleEmail, …,
 * { onComplete: completeSend, context: { sendRef } })` by hand. A new producer
 * that copied one of them and dropped `onComplete` would leave its Send row
 * `queued` forever. The source scan makes the seam structural: naming the worker
 * anywhere else in `convex/` fails here. The unit cases pin what the seam
 * passes to the pools.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { WorkerEnvelopeInput, WorkerRetryState } from '../workerEnvelope';

const { campaignEnqueue, transactionalEnqueue } = vi.hoisted(() => ({
	campaignEnqueue: vi.fn().mockResolvedValue('work-id'),
	transactionalEnqueue: vi.fn().mockResolvedValue('work-id'),
}));

vi.mock('../workpool', () => ({
	campaignEmailPool: { enqueueAction: campaignEnqueue },
	transactionalEmailPool: { enqueueAction: transactionalEnqueue },
}));

import { enqueueGovernedSend, enqueueUntrackedProbe } from '../governedEnqueue';

const CONVEX_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SEAM_FILE = join('delivery', 'governedEnqueue.ts');
const WORKER_REFERENCE = /internal\s*\.\s*delivery\s*\.\s*worker\s*\.\s*sendSingleEmail\b/;

function convexSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === '__tests__' || entry.name === '_generated') continue;
		if (entry.name === 'node_modules') continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...convexSourceFiles(path));
		else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(path);
	}
	return files;
}

describe('governed enqueue seam (source scan)', () => {
	const files = convexSourceFiles(CONVEX_ROOT);

	it('scans the convex tree', () => {
		// A broken root would make the next assertion pass vacuously.
		expect(files.length).toBeGreaterThan(100);
		expect(files.map((f) => relative(CONVEX_ROOT, f))).toContain(SEAM_FILE);
	});

	it('names internal.delivery.worker.sendSingleEmail only in delivery/governedEnqueue.ts', () => {
		const offenders = files
			.map((file) => relative(CONVEX_ROOT, file))
			.filter((rel) => rel !== SEAM_FILE)
			.filter((rel) => WORKER_REFERENCE.test(readFileSync(join(CONVEX_ROOT, rel), 'utf8')))
			.map((rel) => rel.split(sep).join('/'));
		expect(offenders).toEqual([]);
	});

	it('the seam itself still names the worker', () => {
		expect(readFileSync(join(CONVEX_ROOT, SEAM_FILE), 'utf8')).toMatch(WORKER_REFERENCE);
	});
});

const ctx = {} as MutationCtx;
const envelopeInput = {
	kind: 'transactional',
	to: 'recipient@owlat.test',
	from: 'sender@owlat.test',
	template: { subject: 'Hi', htmlContent: '<p>Hi</p>' },
} as WorkerEnvelopeInput;
const retryState: WorkerRetryState = {
	attempt: 2,
	startedAt: 1_700_000_000_000,
	idempotencyKey: 'msg-1',
};
const campaignSendId = 'campaign-send' as Id<'emailSends'>;
const transactionalSendId = 'transactional-send' as Id<'transactionalSends'>;
const WORKER = 'delivery/worker:sendSingleEmail';
const COMPLETION = 'delivery/sendCompletion:completeSend';

/**
 * Function references are `anyApi` proxies, and any two of them are `toEqual`
 * each other, so the calls are compared by function NAME.
 */
function describeCall(call: unknown[] | undefined) {
	const [callCtx, fn, workerArgs, options] = call ?? [];
	const opts = options as { onComplete?: FunctionReference<'mutation'>; context?: unknown };
	return {
		ctx: callCtx,
		worker: getFunctionName(fn as FunctionReference<'action'>),
		workerArgs,
		...(call && call.length > 3
			? {
					onComplete: opts.onComplete ? getFunctionName(opts.onComplete) : undefined,
					context: opts.context,
				}
			: {}),
		argCount: call?.length,
	};
}

describe('enqueueGovernedSend', () => {
	beforeEach(() => {
		campaignEnqueue.mockClear();
		transactionalEnqueue.mockClear();
	});

	it('puts a campaign Send on the campaign pool with the completion owner wired', async () => {
		const sendRef = { kind: 'campaign', id: campaignSendId } as const;
		await enqueueGovernedSend(ctx, sendRef, { envelopeInput });

		expect(transactionalEnqueue).not.toHaveBeenCalled();
		expect(campaignEnqueue).toHaveBeenCalledTimes(1);
		expect(describeCall(campaignEnqueue.mock.calls[0])).toEqual({
			ctx,
			worker: WORKER,
			workerArgs: { envelopeInput },
			onComplete: COMPLETION,
			context: { sendRef },
			argCount: 4,
		});
	});

	it('puts a transactional Send on the transactional pool and forwards retryState', async () => {
		const sendRef = { kind: 'transactional', id: transactionalSendId } as const;
		await enqueueGovernedSend(ctx, sendRef, { envelopeInput, retryState });

		expect(campaignEnqueue).not.toHaveBeenCalled();
		expect(transactionalEnqueue).toHaveBeenCalledTimes(1);
		expect(describeCall(transactionalEnqueue.mock.calls[0])).toEqual({
			ctx,
			worker: WORKER,
			workerArgs: { envelopeInput, retryState },
			onComplete: COMPLETION,
			context: { sendRef },
			argCount: 4,
		});
	});

	it('omits retryState from the worker args on a first enqueue', async () => {
		await enqueueGovernedSend(
			ctx,
			{ kind: 'transactional', id: transactionalSendId },
			{ envelopeInput }
		);
		const workerArgs = transactionalEnqueue.mock.calls[0]?.[2] as Record<string, unknown>;
		expect(Object.keys(workerArgs)).toEqual(['envelopeInput']);
	});
});

describe('enqueueUntrackedProbe', () => {
	beforeEach(() => {
		campaignEnqueue.mockClear();
		transactionalEnqueue.mockClear();
	});

	it.each([
		['campaign', campaignEnqueue, transactionalEnqueue],
		['transactional', transactionalEnqueue, campaignEnqueue],
	] as const)('enqueues a %s probe with no completion callback', async (pool, used, unused) => {
		await enqueueUntrackedProbe(ctx, pool, envelopeInput);

		expect(unused).not.toHaveBeenCalled();
		expect(used).toHaveBeenCalledTimes(1);
		// Exactly three arguments: no options object, so no onComplete and no
		// sendRef. A probe has no Send row for a completion to close.
		expect(describeCall(used.mock.calls[0])).toEqual({
			ctx,
			worker: WORKER,
			workerArgs: { envelopeInput },
			argCount: 3,
		});
	});
});
