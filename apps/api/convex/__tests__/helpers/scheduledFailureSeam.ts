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
 * mocked console no longer hides the failure. A second sink call, where
 * convex-test arms a scheduled job's timer, tells the gate which test
 * scheduled each job.
 *
 * If a convex-test upgrade changes either line, the transform throws and every
 * test that loads convex-test fails, rather than the gate going quiet.
 */

export const SCHEDULED_FAILURE_SINK = 'owlat.test.scheduledFailureSink';

/** Where convex-test reports each job it schedules, so a failure can be tied to its test. */
export const SCHEDULED_JOB_SINK = 'owlat.test.scheduledJobSink';

const CONVEX_TEST_ENTRY = /[\\/]node_modules[\\/]convex-test[\\/]dist[\\/]index\.js(\?.*)?$/;

const sink = (key: string) => `globalThis[Symbol.for(${JSON.stringify(key)})]?.`;

// The statement in convex-test's scheduled-function runner that reports a throw.
// `name` is undefined for a job scheduled through a function handle, so the
// sink gets the resolved path, which is also what the job row records.
const REPORT_LINE = 'console.error(`Error when running scheduled function ${name}`, error);';
const REPORT_WITH_SINK =
	`${sink(SCHEDULED_FAILURE_SINK)}(name ?? functionPath.udfPath, error, { db, jobId });` +
	REPORT_LINE;

// The statement in convex-test's `1.0/schedule` syscall that arms the job's
// timer, with the new job's id, its database and its harness's scheduler in
// scope. A job scheduled from inside a running scheduled function carries that
// function's job id in the request metadata, so the gate can hand the new job
// to the same test. The call leaves the transaction's global overrides first,
// as convex-test's own timer code does: the gate is test code, not the
// function under test, and may touch timers.
const SCHEDULE_LINE = 'scheduler.timerScheduled();';
const SCHEDULE_WITH_SINK =
	`globalOverridesStorage.exit(() => ${sink(SCHEDULED_JOB_SINK)}({ db, jobId, scheduler, ` +
	`scheduledTime: tsInSecs * 1000, ` +
	`parentJobId: requestMetadataStorage.getStore()?.scheduledFunctionId ?? null }));` +
	SCHEDULE_LINE;

// Module-level names the injected code reads from convex-test's own scope.
const REQUIRED_SCOPE = ['const requestMetadataStorage = ', 'const globalOverridesStorage = '];

function expectOnce(code: string, needle: string, id: string): void {
	const occurrences = code.split(needle).length - 1;
	if (occurrences !== 1) {
		throw new Error(
			`scheduledFailureSeam: expected one \`${needle}\` in ${id}, found ${occurrences}. ` +
				`convex-test changed; update convex/__tests__/helpers/scheduledFailureSeam.ts so ` +
				`the scheduled-failure gate still sees throwing scheduled functions.`
		);
	}
}

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
			expectOnce(code, REPORT_LINE, id);
			expectOnce(code, SCHEDULE_LINE, id);
			for (const declaration of REQUIRED_SCOPE) expectOnce(code, declaration, id);
			return code
				.replace(REPORT_LINE, () => REPORT_WITH_SINK)
				.replace(SCHEDULE_LINE, () => SCHEDULE_WITH_SINK);
		},
	};
}
