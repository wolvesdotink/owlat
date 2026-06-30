import { describe, it, expect, vi } from 'vitest';
import { compose, runPipeline, type Phase } from '../pipeline.js';
import type { BasePhaseCtx, BounceAttempt, PhaseDeps } from '../types.js';

function makeBaseCtx(): BasePhaseCtx {
	return {
		parsed: {} as never,
		rawBuffer: Buffer.alloc(0),
		rcptTo: 'a@b.c',
	};
}

const deps: PhaseDeps = { redis: {} as never, config: {} as never };

const passthrough = (name: string): Phase<BasePhaseCtx, BasePhaseCtx> => ({
	name,
	async run(_deps, ctx) {
		return { kind: 'continue', ctx };
	},
});

const dropper = (name: string, reason: string): Phase<BasePhaseCtx, BasePhaseCtx> => ({
	name,
	async run() {
		return { kind: 'dropSilently', reason };
	},
});

const classifier = (name: string, attempt: BounceAttempt): Phase<BasePhaseCtx, BasePhaseCtx> => ({
	name,
	async run() {
		return { kind: 'bounceTo', attempt };
	},
});

describe('runPipeline (bounce)', () => {
	it('returns continue when every phase continues', async () => {
		const pipeline = compose(passthrough('a'), passthrough('b'), passthrough('c'));
		const result = await runPipeline(deps, pipeline, makeBaseCtx());
		expect(result.kind).toBe('continue');
	});

	it('short-circuits on the first dropSilently and attributes it to the phase', async () => {
		const tail = vi.fn(passthrough('tail').run);
		const pipeline = compose(passthrough('head'), dropper('dedup', 'duplicate_fbl_complaint'), {
			...passthrough('tail'),
			run: tail,
		});
		const result = await runPipeline(deps, pipeline, makeBaseCtx());
		expect(result).toEqual({
			kind: 'dropSilently',
			reason: 'duplicate_fbl_complaint',
			phase: 'dedup',
		});
		expect(tail).not.toHaveBeenCalled();
	});

	it('short-circuits on the first bounceTo with the phase name', async () => {
		const tail = vi.fn(passthrough('tail').run);
		const pipeline = compose(
			classifier('parse', { kind: 'dsn_unattributed' }),
			{ ...passthrough('tail'), run: tail },
		);
		const result = await runPipeline(deps, pipeline, makeBaseCtx());
		expect(result).toEqual({
			kind: 'bounceTo',
			attempt: { kind: 'dsn_unattributed' },
			phase: 'parse',
		});
		expect(tail).not.toHaveBeenCalled();
	});

	it('threads enriched ctx through the chain', async () => {
		interface Enriched extends BasePhaseCtx {
			readonly tag: string;
		}
		const enrich: Phase<BasePhaseCtx, Enriched> = {
			name: 'enrich',
			async run(_deps, ctx) {
				return { kind: 'continue', ctx: { ...ctx, tag: 'hello' } };
			},
		};
		const consume: Phase<Enriched, Enriched> = {
			name: 'consume',
			async run(_deps, ctx) {
				expect(ctx.tag).toBe('hello');
				return { kind: 'continue', ctx };
			},
		};
		const pipeline = compose(passthrough('a'), enrich, consume);
		const result = await runPipeline(deps, pipeline, makeBaseCtx());
		expect(result.kind).toBe('continue');
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
		await runPipeline(deps, pipeline, makeBaseCtx());
		expect(calls).toEqual(['a', 'b', 'c']);
	});
});
