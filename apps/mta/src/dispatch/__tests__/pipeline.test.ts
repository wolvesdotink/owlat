import { describe, it, expect, vi } from 'vitest';
import { compose, runPipeline, type Phase } from '../pipeline.js';
import type { BasePhaseCtx, PhaseDeps } from '../types.js';
import type { EmailJob } from '../../types.js';

interface CtxWithPool extends BasePhaseCtx {
	readonly pool: 'transactional' | 'campaign';
}
interface CtxWithIp extends CtxWithPool {
	readonly ip: string;
}

function makeBaseCtx(): BasePhaseCtx {
	const job: EmailJob = {
		messageId: 'msg-1',
		to: 'user@example.com',
		from: 'sender@owlat.com',
		subject: 'Test',
		html: '<p>Hello</p>',
		ipPool: 'transactional',
		organizationId: 'org-1',
		dkimDomain: 'owlat.com',
	};
	return { job, domain: 'example.com', isp: 'other', fromDomain: 'owlat.com' };
}

function makeDeps(): PhaseDeps {
	return { redis: {} as never, config: {} as never };
}

const passthrough = (name: string): Phase<BasePhaseCtx, BasePhaseCtx> => ({
	name,
	async run(_deps, ctx) {
		return { kind: 'continue', ctx };
	},
});

const deferring = (
	name: string,
	delayMs: number,
	reason: string,
): Phase<BasePhaseCtx, BasePhaseCtx> => ({
	name,
	async run() {
		return { kind: 'defer', delayMs, reason };
	},
});

const dropping = (
	name: string,
	status: 'screened' | 'suppressed',
	reason: string,
): Phase<BasePhaseCtx, BasePhaseCtx> => ({
	name,
	async run() {
		return { kind: 'drop', status, reason };
	},
});

describe('runPipeline', () => {
	it('returns continue when every phase continues', async () => {
		const pipeline = compose(passthrough('a'), passthrough('b'), passthrough('c'));
		const result = await runPipeline(makeDeps(), pipeline, makeBaseCtx());

		expect(result.kind).toBe('continue');
	});

	it('threads enriched ctx through the chain', async () => {
		const enrichPool: Phase<BasePhaseCtx, CtxWithPool> = {
			name: 'enrich_pool',
			async run(_deps, ctx) {
				return { kind: 'continue', ctx: { ...ctx, pool: 'campaign' } };
			},
		};

		const enrichIp: Phase<CtxWithPool, CtxWithIp> = {
			name: 'enrich_ip',
			async run(_deps, ctx) {
				expect(ctx.pool).toBe('campaign');
				return { kind: 'continue', ctx: { ...ctx, ip: '10.0.0.5' } };
			},
		};

		const pipeline = compose(passthrough('a'), enrichPool, enrichIp);
		const result = await runPipeline(makeDeps(), pipeline, makeBaseCtx());

		expect(result.kind).toBe('continue');
		if (result.kind === 'continue') {
			expect(result.ctx.ip).toBe('10.0.0.5');
			expect(result.ctx.pool).toBe('campaign');
		}
	});

	it('short-circuits on the first defer and attributes it to the phase', async () => {
		const stop = deferring('limiter', 12_345, 'rate limited');
		const tail = vi.fn(passthrough('tail').run);
		const pipeline = compose(passthrough('head'), stop, { ...passthrough('tail'), run: tail });

		const result = await runPipeline(makeDeps(), pipeline, makeBaseCtx());

		expect(result).toEqual({
			kind: 'defer',
			delayMs: 12_345,
			reason: 'rate limited',
			phase: 'limiter',
		});
		expect(tail).not.toHaveBeenCalled();
	});

	it('short-circuits on the first drop with the phase name', async () => {
		const stop = dropping('screen', 'screened', 'content_screened');
		const tail = vi.fn(passthrough('tail').run);
		const pipeline = compose(stop, { ...passthrough('tail'), run: tail });

		const result = await runPipeline(makeDeps(), pipeline, makeBaseCtx());

		expect(result).toEqual({
			kind: 'drop',
			status: 'screened',
			reason: 'content_screened',
			phase: 'screen',
		});
		expect(tail).not.toHaveBeenCalled();
	});

	it('runs phases in declared order', async () => {
		const calls: string[] = [];
		const recorder = (name: string): Phase<BasePhaseCtx, BasePhaseCtx> => ({
			name,
			async run(_deps, ctx) {
				calls.push(name);
				return { kind: 'continue', ctx };
			},
		});

		const pipeline = compose(recorder('a'), recorder('b'), recorder('c'));
		await runPipeline(makeDeps(), pipeline, makeBaseCtx());

		expect(calls).toEqual(['a', 'b', 'c']);
	});
});
