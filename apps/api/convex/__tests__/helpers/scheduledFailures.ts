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
 *   - Every unexcused failure is also reported again in `afterAll`, naming
 *     the test that scheduled it and the one it ran during. `afterAll` runs
 *     once per file, so a test run with `--retry` cannot hide a failure behind
 *     an attempt that passed.
 *
 * Before the file ends, `afterAll` also runs the jobs set on real timers to
 * fire within {@link DRAIN_WINDOW_MS} (typically `runAfter(0, ...)` from the
 * last test), so one that would throw after the file is gone is still seen.
 * The seam hands the gate each job's timer callback, so such a job runs at
 * once rather than after its delay, and nothing here waits on the clock. A job
 * must never see a clock before its scheduled time, so the drain first moves
 * `Date` forward to the latest due time it runs, and hands the real clock back
 * when it is done. It does that only on a clock nobody else controls: under
 * fake timers or a test's own `vi.setSystemTime`, it runs only the jobs already
 * due. The remaining blind spot: a job scheduled further out than that, or on
 * fake timers that were never advanced, never runs at all, so there is nothing
 * to see. Drain scheduled work with `t.finishAllScheduledFunctions(...)` so
 * failures land in the test that caused them.
 */
import { afterAll, afterEach, beforeEach, vi } from 'vitest';
import {
	SCHEDULED_FAILURE_SINK,
	SCHEDULED_JOB_ARM,
	SCHEDULED_JOB_SINK,
} from './scheduledFailureSeam';

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
	/**
	 * When its timer fires on the real clock (moved forward while a drain runs
	 * jobs early); null when it was set on fake timers.
	 */
	readonly dueAt: number | null;
	drained: boolean;
	/** Runs the job now if its timer has not yet; later calls, the timer's included, do nothing. */
	fire?: () => void;
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
	/** What `Date.now()` reads while a drain runs jobs before their timers; null otherwise. */
	drainClock: number | null;
}

/** How far ahead `afterAll` looks for real-timer jobs to run before the file ends. */
const DRAIN_WINDOW_MS = 1000;
const DRAIN_ROUNDS = 10;

// Captured before any test installs fake timers.
const realDateNow = Date.now.bind(Date);

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
		drainClock: null,
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

/**
 * A real-timer job's due time on the clock the drain compares against. Where
 * `Date` is the real clock, or the drain's own, that is the scheduled time
 * itself; under a test's mocked `Date`, the delay convex-test armed, counted
 * from now.
 */
function realDueAt(state: GateState, scheduledTime: number): number {
	if (state.drainClock !== null || vi.getMockedSystemTime() === null) return scheduledTime;
	return realDateNow() + Math.max(0, scheduledTime - Date.now());
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
		dueAt: vi.isFakeTimers() ? null : realDueAt(state, job.scheduledTime),
		drained: false,
	};
	jobs.set(job.jobId, record);
	state.scheduled.push(record);
}

/**
 * Arm a job's timer with a callback the gate can also call: whichever runs
 * first runs the job, so the job still runs once.
 */
function armScheduledJob(
	arm: (run: () => void, ms: number) => unknown,
	job: { db: object; jobId: string },
	run: () => void,
	ms: number
): unknown {
	let hasRun = false;
	const fire = () => {
		if (hasRun) return;
		hasRun = true;
		run();
	};
	const record = gate().jobs.get(job.db)?.get(job.jobId);
	if (record) record.fire = fire;
	return arm(fire, ms);
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

/** Move `Date` forward to `to`, never back, for the jobs a drain runs early. */
function advanceDrainClock(state: GateState, to: number): void {
	const target = Math.max(to, state.drainClock ?? 0, realDateNow());
	if (state.drainClock === null && target <= realDateNow()) return;
	state.drainClock = target;
	vi.setSystemTime(target);
}

/**
 * Run the jobs set on real timers to fire within `windowMs` from now, without
 * waiting for their timers, and await them and every job they schedule in that
 * window, up to {@link DRAIN_ROUNDS} generations deep. Each round first moves
 * `Date` to the latest due time it runs, so no job runs before its scheduled
 * time by the clock it reads, and the real clock is back once the drain ends.
 * Only a clock the gate owns is moved: under fake timers or a test's mocked
 * `Date` the window shrinks to the jobs already due. Jobs on fake timers are
 * left to the test's own clock.
 */
async function drainDueJobs(state: GateState, windowMs: number): Promise<void> {
	const ownsClock = !vi.isFakeTimers() && vi.getMockedSystemTime() === null;
	const reach = ownsClock ? windowMs : 0;
	try {
		for (let round = 0; round < DRAIN_ROUNDS; round++) {
			const horizon = Math.max(state.drainClock ?? 0, realDateNow()) + reach;
			const due = state.scheduled.filter(
				(job) => !job.drained && job.dueAt !== null && job.dueAt <= horizon
			);
			if (due.length === 0) return;
			if (ownsClock) advanceDrainClock(state, Math.max(...due.map((job) => job.dueAt ?? 0)));
			for (const job of due) {
				job.drained = true;
				job.fire?.();
			}
			for (const scheduler of new Set(due.map((job) => job.scheduler))) {
				await scheduler.finishInProgressScheduledFunctions();
			}
		}
	} finally {
		if (state.drainClock !== null) {
			state.drainClock = null;
			// Only the Date mock the drain set is undone: it owned the clock.
			vi.useRealTimers();
		}
	}
}

/**
 * Run every job already due on real timers (the `runAfter(0, ...)` fan-out a
 * handler queued) and await it, with the jobs it schedules for now, whichever
 * harness scheduled it. For a suite where each test builds its own harness:
 * drained in `afterEach`, that work cannot outlive its test and run against
 * the next test's convex-test state.
 */
export function drainDueScheduledJobs(): Promise<void> {
	return drainDueJobs(gate(), 0);
}

/**
 * Run, as `afterAll` does, the real-timer jobs due within `windowMs`, with
 * `Date` moved to their due times while they run. The gate's own tests use it.
 */
export function drainScheduledJobsDueWithin(windowMs: number): Promise<void> {
	return drainDueJobs(gate(), windowMs);
}

/** Connect the sinks convex-test reports to, and register the hooks. */
export function installScheduledFailureGate(): void {
	const state = gate();
	const sinks = globalThis as Record<symbol, unknown>;
	sinks[Symbol.for(SCHEDULED_FAILURE_SINK)] = recordScheduledFailure;
	sinks[Symbol.for(SCHEDULED_JOB_SINK)] = recordScheduledJob;
	sinks[Symbol.for(SCHEDULED_JOB_ARM)] = armScheduledJob;

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
		await drainScheduledJobsDueWithin(DRAIN_WINDOW_MS);
		const failures = state.fileFailures;
		state.fileFailures = [];
		state.fileExpected = [];
		state.scheduled = [];
		state.jobs = new WeakMap();
		if (failures.length === 0) return;
		throw new Error(
			`${failures.length} scheduled function(s) threw in this file. Each is reported here ` +
				`with where it came from, and a job that outlived the test that scheduled it ` +
				`is reported only here. ${OPT_OUT_HINT}:\n` +
				describeFailures(failures, true)
		);
	});
}
