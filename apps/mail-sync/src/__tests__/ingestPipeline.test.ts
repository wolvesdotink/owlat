/**
 * The ingest pipeline (plan 3.6): uploads overlap, commits stay in order.
 *
 * Forward sync used to pay the raw upload and the ingest call for one message
 * before it even looked at the next. The pipeline stages the next few uploads
 * while the current message commits, and the commit order is what the folder
 * cursor relies on, so both halves are pinned here.
 */

import { describe, expect, it } from 'vitest';
import { runIngestPipeline, type StageResult } from '../ingestPipeline.js';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('runIngestPipeline', () => {
	it('stages up to `concurrency` items before the first one commits', async () => {
		const gates = [1, 2, 3, 4, 5, 6].map(() => deferred<string>());
		const staged: number[] = [];
		const committed: number[] = [];
		let inFlight = 0;
		let peak = 0;

		const run = runIngestPipeline([1, 2, 3, 4, 5, 6], {
			concurrency: 4,
			stage: async (n) => {
				staged.push(n);
				inFlight++;
				peak = Math.max(peak, inFlight);
				try {
					return await gates[n - 1]!.promise;
				} finally {
					inFlight--;
				}
			},
			commit: async (n) => {
				committed.push(n);
			},
			isStopped: () => false,
		});

		await flush();
		// Four uploads are running and nothing has committed: the old loop would
		// have been waiting on the first upload alone.
		expect(staged).toEqual([1, 2, 3, 4]);
		expect(committed).toEqual([]);

		// Out-of-order completion does not reorder the commits.
		gates[3]!.resolve('d');
		gates[1]!.resolve('b');
		await flush();
		expect(committed).toEqual([]);
		gates[0]!.resolve('a');
		gates[2]!.resolve('c');
		gates[4]!.resolve('e');
		gates[5]!.resolve('f');

		await expect(run).resolves.toEqual([1, 2, 3, 4, 5, 6]);
		expect(committed).toEqual([1, 2, 3, 4, 5, 6]);
		expect(peak).toBeLessThanOrEqual(4);
	});

	it('hands a failed stage to commit in its turn instead of throwing', async () => {
		const seen: Array<[number, StageResult<string>]> = [];
		await runIngestPipeline([1, 2, 3], {
			concurrency: 3,
			stage: async (n) => {
				if (n === 2) throw new Error('upload failed');
				return `s${n}`;
			},
			commit: async (n, result) => {
				seen.push([n, result]);
			},
			isStopped: () => false,
		});

		expect(seen.map(([n]) => n)).toEqual([1, 2, 3]);
		expect(seen[1]![1]).toMatchObject({ ok: false });
		expect((seen[1]![1] as { error: Error }).error.message).toBe('upload failed');
		expect(seen[2]![1]).toEqual({ ok: true, value: 's3' });
	});

	it('stops committing at the first commit that throws', async () => {
		const committed: number[] = [];
		await expect(
			runIngestPipeline([1, 2, 3, 4], {
				concurrency: 2,
				stage: async (n) => n,
				commit: async (n) => {
					if (n === 2) throw new Error('ledger write failed');
					committed.push(n);
				},
				isStopped: () => false,
			})
		).rejects.toThrow('ledger write failed');
		expect(committed).toEqual([1]);
	});

	it('commits nothing more once stopped', async () => {
		let stopped = false;
		const committed: number[] = [];
		const result = await runIngestPipeline([1, 2, 3, 4], {
			concurrency: 2,
			stage: async (n) => n,
			commit: async (n) => {
				committed.push(n);
				if (n === 2) stopped = true;
			},
			isStopped: () => stopped,
		});
		expect(committed).toEqual([1, 2]);
		expect(result).toEqual([1, 2]);
	});

	it('commits what the source yielded before it broke, then rethrows', async () => {
		async function* source() {
			yield 1;
			yield 2;
			throw new Error('remote disconnected');
		}
		const committed: number[] = [];
		await expect(
			runIngestPipeline(source(), {
				concurrency: 4,
				stage: async (n) => n,
				commit: async (n) => {
					committed.push(n);
				},
				isStopped: () => false,
			})
		).rejects.toThrow('remote disconnected');
		expect(committed).toEqual([1, 2]);
	});

	it('runs strictly one at a time with a concurrency of 1', async () => {
		const events: string[] = [];
		await runIngestPipeline([1, 2, 3], {
			concurrency: 1,
			stage: async (n) => {
				events.push(`stage:${n}`);
				return n;
			},
			commit: async (n) => {
				events.push(`commit:${n}`);
			},
			isStopped: () => false,
		});
		expect(events).toEqual(['stage:1', 'commit:1', 'stage:2', 'commit:2', 'stage:3', 'commit:3']);
	});
});
