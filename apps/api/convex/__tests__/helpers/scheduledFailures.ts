/**
 * Scheduled functions that throw fail the test that scheduled them.
 *
 * convex-test runs a scheduled function inside its own try/catch: a throw is
 * logged as `Error when running scheduled function <name>` and the job is
 * marked `failed`, and nothing reaches the test. So a scheduled effect that
 * broke (a bad argument, a missing row, a validator that no longer matches)
 * left a passing suite. `vitest.setup.ts` installs this gate, and the Vite
 * plugin in `scheduledFailureSeam.ts` (wired in `vitest.config.ts`) makes
 * convex-test report each job it schedules and each job that throws to it,
 * whether or not `console.error` is mocked.
 *
 * Every job is tied to the test that scheduled it (a job scheduled by another
 * job inherits that job's test), and a failure is judged by that test:
 *   - A test that deliberately makes a scheduled function throw names it with
 *     `expectScheduledFailure(...)`. The excuse is per test and per function
 *     name, and it follows the test's jobs: one that fires later, during
 *     another test, is still excused and fails nothing.
 *   - An unexcused failure of a job the running test scheduled fails that test
 *     in `afterEach`.
 *   - An unexcused failure of a job an earlier test left undrained, or one that
 *     fires between tests, does not fail the innocent test that happens to be
 *     running. It fails the file in `afterAll`, naming the test that
 *     scheduled it.
 *   - Every unexcused failure is also reported again in `afterAll`. The api
 *     suite retries a failed test once (`retry: 1`), and `afterAll` is not
 *     retried, so a retry that passes cannot hide the failure of the attempt
 *     before it.
 *
 * Before the file ends, `afterAll` also waits for jobs that were due within
 * {@link DRAIN_WINDOW_MS} on real timers (typically `runAfter(0, ...)` from
 * the last test), so one that would throw after the file is gone is still
 * seen. The remaining blind spot: a job scheduled further out than that, or
 * on fake timers that were never advanced, never runs at all, so there is
 * nothing to see. Drain scheduled work with `t.finishAllScheduledFunctions(...)`
 * so failures land in the test that caused them.
 */
import { afterAll, afterEach, beforeEach, vi } from 'vitest';
import { SCHEDULED_FAILURE_SINK, SCHEDULED_JOB_SINK } from './scheduledFailureSeam';

export interface ScheduledFailure {
	/** The scheduled function, as convex-test names it (`module/path:export`). */
	readonly name: string;
	readonly error: unknown;
}

type Excuse = string | RegExp;

interface TestRecord {
	readonly name: string;
	readonly expected: Excuse[];
}

/** convex-test's per-harness scheduler, as far as the drain needs it. */
interface DrainableScheduler {
	finishInProgressScheduledFunctions(): Promise<void>;
}

interface JobRecord {
	/** The test whose code (or whose job) scheduled it; null for setup code. */
	readonly owner: TestRecord | null;
	readonly scheduler: DrainableScheduler;
	/** When its timer fires on the real clock; null when it was set on fake timers. */
	readonly dueAt: number | null;
	drained: boolean;
}

interface FileFailure extends ScheduledFailure {
	readonly scheduledBy: string | null;
	readonly ranDuring: string | null;
}

interface GateState {
	current: TestRecord | null;
	/** Excuses given outside any test (in `beforeAll`), valid for the whole file. */
	fileExpected: Excuse[];
	/** Unexcused failures of the running test's own jobs. */
	failed: FileFailure[];
	/** Every unexcused failure in this file, reported again in `afterAll`. */
	fileFailures: FileFailure[];
	/** Jobs by harness database and job id, for attribution. */
	jobs: WeakMap<object, Map<string, JobRecord>>;
	/** Jobs scheduled in this file, for the drain in `afterAll`. */
	scheduled: JobRecord[];
}

/** How far ahead `afterAll` waits for real-timer jobs before the file ends. */
const DRAIN_WINDOW_MS = 1000;
const DRAIN_ROUNDS = 10;

// Captured before any test installs fake timers.
const realDateNow = Date.now.bind(Date);
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

// On globalThis so a test that resets the module registry still reaches the
// same state the setup file installed.
const STATE_KEY = Symbol.for('owlat.test.scheduledFailureGate');

function gate(): GateState {
	const holder = globalThis as { [STATE_KEY]?: GateState };
	holder[STATE_KEY] ??= {
		current: null,
		fileExpected: [],
		failed: [],
		fileFailures: [],
		jobs: new WeakMap(),
		scheduled: [],
	};
	return holder[STATE_KEY];
}

function matches(excuses: readonly Excuse[] | undefined, name: string): boolean {
	return (excuses ?? []).some((pattern) =>
		typeof pattern === 'string' ? pattern === name : pattern.test(name)
	);
}

/**
 * Excuse failures of the named scheduled function for the rest of the current
 * test, including its jobs that fire later. Use it only where the test sets
 * out to make that function throw.
 */
export function expectScheduledFailure(name: Excuse): void {
	const state = gate();
	(state.current?.expected ?? state.fileExpected).push(name);
}

interface ScheduledJob {
	db: object;
	jobId: string;
	scheduler: DrainableScheduler;
	/** Epoch ms the job is scheduled for, on the clock convex-test used. */
	scheduledTime: number;
	/** The running scheduled function's job id, when a job schedules another. */
	parentJobId: string | null;
}

/** Remember who scheduled a job and when its timer fires. */
function recordScheduledJob(job: ScheduledJob): void {
	const state = gate();
	let jobs = state.jobs.get(job.db);
	if (!jobs) {
		jobs = new Map();
		state.jobs.set(job.db, jobs);
	}
	const parent = job.parentJobId === null ? undefined : jobs.get(job.parentJobId);
	const record: JobRecord = {
		owner: parent ? parent.owner : state.current,
		scheduler: job.scheduler,
		dueAt: vi.isFakeTimers() ? null : realDateNow() + Math.max(0, job.scheduledTime - Date.now()),
		drained: false,
	};
	jobs.set(job.jobId, record);
	state.scheduled.push(record);
}

/** Record a scheduled function that threw, unless the test behind it expects it. */
function recordScheduledFailure(
	name: string,
	error: unknown,
	job?: { db: object; jobId: string }
): void {
	const state = gate();
	const owner = (job && state.jobs.get(job.db)?.get(job.jobId)?.owner) ?? null;
	if (
		matches(owner?.expected, name) ||
		matches(state.current?.expected, name) ||
		matches(state.fileExpected, name)
	) {
		return;
	}
	const failure: FileFailure = {
		name,
		error,
		scheduledBy: owner?.name ?? null,
		ranDuring: state.current?.name ?? null,
	};
	state.fileFailures.push(failure);
	// A job whose test is unknown (scheduled by setup code) is charged to the
	// running test, the likeliest consumer; a job of another test is not.
	if (state.current && (owner === null || owner === state.current)) state.failed.push(failure);
}

function describeFailures(failures: readonly FileFailure[], withOrigin: boolean): string {
	return failures
		.map(({ name, error, scheduledBy, ranDuring }) => {
			const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
			const origin = withOrigin
				? ` (scheduled by ${scheduledBy === null ? 'setup code' : `"${scheduledBy}"`}, ` +
					`ran ${ranDuring === null ? 'outside any test' : `during "${ranDuring}"`})`
				: '';
			return `  ${name}${origin}\n    ${detail.split('\n').join('\n    ')}`;
		})
		.join('\n');
}

/**
 * Hand back and clear the unexcused failures recorded in the current test.
 * The gate's own tests use it to inspect what was caught without failing.
 */
export function takeScheduledFailures(): ScheduledFailure[] {
	const state = gate();
	const taken = state.failed;
	state.failed = [];
	state.fileFailures = state.fileFailures.filter((failure) => !taken.includes(failure));
	return taken;
}

const OPT_OUT_HINT =
	`Fix the failure, or call expectScheduledFailure('<module/path:export>') in the ` +
	`test that sets out to cause it`;

/**
 * Wait for jobs due within {@link DRAIN_WINDOW_MS} on real timers, including
 * the ones they schedule, so a job the last test left behind runs (and is
 * judged) before the file ends.
 */
async function drainDueJobs(state: GateState): Promise<void> {
	for (let round = 0; round < DRAIN_ROUNDS; round++) {
		const horizon = realDateNow() + DRAIN_WINDOW_MS;
		const due = state.scheduled.filter(
			(job) => !job.drained && job.dueAt !== null && job.dueAt <= horizon
		);
		if (due.length === 0) return;
		const latest = Math.max(...due.map((job) => job.dueAt ?? 0));
		await new Promise((resolve) =>
			realSetTimeout(resolve, Math.max(0, latest - realDateNow()) + 1)
		);
		for (const job of due) job.drained = true;
		for (const scheduler of new Set(due.map((job) => job.scheduler))) {
			await scheduler.finishInProgressScheduledFunctions();
		}
	}
}

/** Connect the sinks convex-test reports to, and register the hooks. */
export function installScheduledFailureGate(): void {
	const state = gate();
	const sinks = globalThis as Record<symbol, unknown>;
	sinks[Symbol.for(SCHEDULED_FAILURE_SINK)] = recordScheduledFailure;
	sinks[Symbol.for(SCHEDULED_JOB_SINK)] = recordScheduledJob;

	beforeEach((context) => {
		state.current = { name: context.task.name, expected: [] };
		state.failed = [];
	});
	afterEach(() => {
		const failures = state.failed;
		state.failed = [];
		state.current = null;
		if (failures.length === 0) return;
		throw new Error(
			`${failures.length} scheduled function(s) threw during this test. ${OPT_OUT_HINT}:\n` +
				describeFailures(failures, false)
		);
	});
	afterAll(async () => {
		await drainDueJobs(state);
		const failures = state.fileFailures;
		state.fileFailures = [];
		state.fileExpected = [];
		state.scheduled = [];
		state.jobs = new WeakMap();
		if (failures.length === 0) return;
		throw new Error(
			`${failures.length} scheduled function(s) threw in this file. Each is reported here ` +
				`even if a retry of its test passed, and a job that outlived the test that ` +
				`scheduled it is reported only here. ${OPT_OUT_HINT}:\n` +
				describeFailures(failures, true)
		);
	});
}
