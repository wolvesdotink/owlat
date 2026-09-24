/**
 * The channel through which convex-test reports a throwing scheduled function
 * to the scheduled-failure gate (`scheduledFailures.ts`).
 *
 * convex-test catches the throw and only calls `console.error`. Watching
 * `console.error` is not enough: several suites replace it with a silent mock
 * (`vi.spyOn(console, 'error').mockImplementation(...)`), and `vi.spyOn`
 * redefines the property outright, so no wrapper or accessor installed on
 * `console` survives it. convex-test is inlined into the Vite pipeline
 * (`server.deps.inline`), so this plugin instead adds a call to a sink on
 * `globalThis` right before that log line. Tests do not touch the sink, so a
 * mocked console no longer hides the failure.
 *
 * If a convex-test upgrade changes the line, the transform throws and every
 * test that loads convex-test fails, rather than the gate going quiet.
 */

export const SCHEDULED_FAILURE_SINK = 'owlat.test.scheduledFailureSink';

const CONVEX_TEST_ENTRY = /[\\/]node_modules[\\/]convex-test[\\/]dist[\\/]index\.js(\?.*)?$/;

// The statement in convex-test's scheduled-function runner that reports a throw.
const REPORT_LINE = 'console.error(`Error when running scheduled function ${name}`, error);';

const SINK_CALL =
	`globalThis[Symbol.for(${JSON.stringify(SCHEDULED_FAILURE_SINK)})]?.(name, error);` + REPORT_LINE;

/** Structurally a Vite plugin; typed locally so the api package needs no `vite` import. */
export interface ScheduledFailureSeamPlugin {
	name: string;
	enforce: 'pre';
	transform(code: string, id: string): string | null;
}

export function scheduledFailureSeam(): ScheduledFailureSeamPlugin {
	return {
		name: 'owlat:scheduled-failure-seam',
		enforce: 'pre',
		transform(code, id) {
			if (!CONVEX_TEST_ENTRY.test(id)) return null;
			const occurrences = code.split(REPORT_LINE).length - 1;
			if (occurrences !== 1) {
				throw new Error(
					`scheduledFailureSeam: expected one scheduled-function report line in ${id}, ` +
						`found ${occurrences}. convex-test changed; update ` +
						`convex/__tests__/helpers/scheduledFailureSeam.ts so the scheduled-failure ` +
						`gate still sees throwing scheduled functions.`
				);
			}
			return code.replace(REPORT_LINE, () => SINK_CALL);
		},
	};
}
