// @vitest-environment happy-dom
/**
 * Report-only timing of `applyPostboxImageConsent` on the hostile bodies its
 * tests hold to linear work (postboxRemoteResourcesHostileFixtures.ts), each
 * at n and 4n. The tests count the parsers' work, which a loaded runner cannot
 * disturb; this times the whole call, the DOM parse and any backtracking
 * inside a regex included, which no counter sees.
 *
 * The fidelity block always runs. The timing block runs only under
 * `bun run perf:bench`, which sets OWLAT_PERF_BENCH_OUT; in CI it is skipped,
 * so no timing is ever asserted.
 */
import { describe, expect, it } from 'vitest';
import { applyPostboxImageConsent } from '../postboxRemoteResources';
import { HOSTILE_BODIES } from './postboxRemoteResourcesHostileFixtures';
import {
	perfBenchOutput,
	sampleTask,
	writeFamilyResult,
} from '../../../../../scripts/perf-bench/sample';

const FACTOR = 4;
const LABEL = 'Image blocked';

describe('hostile consent bodies', () => {
	it.each(HOSTILE_BODIES)('$name grows by the size factor', (body) => {
		// The timing ratio means something only if the larger body is about
		// FACTOR times the smaller one.
		const ratio = body.build(FACTOR * body.n).length / body.build(body.n).length;
		expect(ratio).toBeGreaterThan(FACTOR - 0.1);
		expect(ratio).toBeLessThan(FACTOR + 0.2);
	});
});

const output = perfBenchOutput();

describe.runIf(output)('postbox consent scaling benchmark (perf:bench only)', () => {
	it('samples applyPostboxImageConsent at n and 4n', { timeout: 300_000 }, () => {
		const tasks = HOSTILE_BODIES.flatMap((body) =>
			[body.n, FACTOR * body.n].map((n) => {
				const html = body.build(n);
				return sampleTask(
					`${body.name}, n=${n}`,
					() => applyPostboxImageConsent(html, body.consent, LABEL),
					{ warmup: 3, samples: 20, opsPerSample: 1 }
				);
			})
		);
		writeFamilyResult(output!, {
			family: 'postbox-consent-scaling',
			title: 'applyPostboxImageConsent on hostile bodies at n and 4n',
			dataset: {
				'call sites':
					'PostboxMessageBody.vue and usePostboxQuotedText.ts (apps/web), under happy-dom here',
				bodies: HOSTILE_BODIES.map((body) => `${body.name} (n=${body.n}, ${body.consent})`).join(
					'; '
				),
				fixture: 'apps/web/app/utils/__tests__/postboxRemoteResourcesHostileFixtures.ts',
			},
			tasks,
			scaling: HOSTILE_BODIES.map((body) => ({
				name: body.name,
				small: `${body.name}, n=${body.n}`,
				large: `${body.name}, n=${FACTOR * body.n}`,
				factor: FACTOR,
			})),
		});
		expect(tasks.length).toBe(HOSTILE_BODIES.length * 2);
	});
});
