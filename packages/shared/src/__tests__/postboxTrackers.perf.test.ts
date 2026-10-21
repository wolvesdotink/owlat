/**
 * Report-only timing of `stripRemoteImages` on the hostile bodies its tests
 * hold to linear work (postboxTrackersHostileFixtures.ts), each at n and 4n.
 * The tests count work, which a loaded runner cannot disturb; this times it,
 * which also sees backtracking inside a regex that no counter can.
 *
 * The fidelity block always runs. The timing block runs only under
 * `bun run perf:bench`, which sets OWLAT_PERF_BENCH_OUT; in CI it is skipped,
 * so no timing is ever asserted.
 */
import { describe, expect, it } from 'vitest';
import { stripRemoteImages } from '../postboxTrackers';
import { HOSTILE_SHAPES } from './postboxTrackersHostileFixtures';
import {
	perfBenchOutput,
	sampleTask,
	writeFamilyResult,
} from '../../../../scripts/perf-bench/sample';

const FACTOR = 4;

describe('hostile strip bodies', () => {
	it.each(HOSTILE_SHAPES)('$name grows by the size factor', (shape) => {
		// The timing ratio means something only if the larger body is about
		// FACTOR times the smaller one.
		const ratio = shape.build(FACTOR * shape.n).length / shape.build(shape.n).length;
		expect(ratio).toBeGreaterThan(FACTOR - 0.1);
		expect(ratio).toBeLessThanOrEqual(FACTOR);
	});
});

const output = perfBenchOutput();

describe.runIf(output)('postbox strip scaling benchmark (perf:bench only)', () => {
	it('samples stripRemoteImages at n and 4n', { timeout: 300_000 }, () => {
		const tasks = HOSTILE_SHAPES.flatMap((shape) =>
			[shape.n, FACTOR * shape.n].map((n) => {
				const html = shape.build(n);
				return sampleTask(`${shape.name}, n=${n}`, () => stripRemoteImages(html), {
					warmup: 5,
					samples: 30,
					opsPerSample: 2,
				});
			})
		);
		writeFamilyResult(output!, {
			family: 'postbox-strip-scaling',
			title: 'stripRemoteImages on hostile bodies at n and 4n',
			dataset: {
				'call sites':
					'agent reference monitor and context retrieval (apps/api/convex/agent), the reader fallback',
				bodies: HOSTILE_SHAPES.map((shape) => `${shape.name} (n=${shape.n})`).join('; '),
				fixture: 'packages/shared/src/__tests__/postboxTrackersHostileFixtures.ts',
			},
			tasks,
			scaling: HOSTILE_SHAPES.map((shape) => ({
				name: shape.name,
				small: `${shape.name}, n=${shape.n}`,
				large: `${shape.name}, n=${FACTOR * shape.n}`,
				factor: FACTOR,
			})),
		});
		expect(tasks.length).toBe(HOSTILE_SHAPES.length * 2);
	});
});
