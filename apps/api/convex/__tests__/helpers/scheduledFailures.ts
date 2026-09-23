/**
 * Scheduled functions that throw fail the test that was running.
 *
 * convex-test runs a scheduled function inside its own try/catch: a throw is
 * logged as `Error when running scheduled function <name>` and the job is
 * marked `failed`, and nothing reaches the test. So a scheduled effect that
 * broke (a bad argument, a missing row, a validator that no longer matches)
 * left a passing suite. `vitest.setup.ts` installs this gate, which watches for
 * that log line and fails the test it was logged in.
 *
 * A test that deliberately makes a scheduled function throw names it with
 * `expectScheduledFailure(...)`. The excuse is per test and per function name,
 * so an unrelated scheduled failure in the same test still fails it.
 *
 * A failure logged between tests (a job an earlier test left undrained that
 * fired later) is checked against the opt-outs of the test that ran last and,
 * if not excused, fails the file in `afterAll`. Drain scheduled work with
 * `t.finishAllScheduledFunctions(...)` so failures land in the test that caused
 * them. A test that replaces `console.error` with a silent mock also hides
 * this line from the gate while the mock is installed.
 */
import { afterAll, afterEach, beforeEach } from 'vitest';

const CONVEX_TEST_MARKER = 'Error when running scheduled function ';

export interface ScheduledFailure {
	/** The scheduled function, as convex-test names it (`module/path:export`). */
	readonly name: string;
	readonly error: unknown;
}

interface GateState {
	inTest: boolean;
	expected: Array<string | RegExp>;
	/** Unexcused failures logged while a test was running. */
	failed: ScheduledFailure[];
	/** Unexcused failures logged while no test was running. */
	orphaned: ScheduledFailure[];
}

// On globalThis so a test that resets the module registry still reaches the
// same state the setup file installed.
const STATE_KEY = Symbol.for('owlat.test.scheduledFailureGate');

function gate(): GateState {
	const holder = globalThis as { [STATE_KEY]?: GateState };
	holder[STATE_KEY] ??= {
		inTest: false,
		expected: [],
		failed: [],
		orphaned: [],
	};
	return holder[STATE_KEY];
}

function isExpected(name: string): boolean {
	return gate().expected.some((pattern) =>
		typeof pattern === 'string' ? pattern === name : pattern.test(name)
	);
}

/**
 * Excuse failures of the named scheduled function for the rest of the current
 * test. Use it only where the test sets out to make that function throw.
 */
export function expectScheduledFailure(name: string | RegExp): void {
	gate().expected.push(name);
}

/** Record a convex-test scheduled-function failure line, if that is what this is. */
export function recordConsoleError(args: readonly unknown[]): void {
	const [message, error] = args;
	if (typeof message !== 'string' || !message.startsWith(CONVEX_TEST_MARKER)) return;
	const name = message.slice(CONVEX_TEST_MARKER.length);
	if (isExpected(name)) return;
	const state = gate();
	(state.inTest ? state.failed : state.orphaned).push({ name, error });
}

function describeFailures(failures: readonly ScheduledFailure[]): string {
	return failures
		.map(({ name, error }) => {
			const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
			return `  ${name}\n    ${detail.split('\n').join('\n    ')}`;
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
	return taken;
}

function throwIfAny(failures: readonly ScheduledFailure[], where: string): void {
	if (failures.length === 0) return;
	throw new Error(
		`${failures.length} scheduled function(s) threw ${where}. Fix the failure, or call ` +
			`expectScheduledFailure('<module/path:export>') if the test sets out to cause it:\n` +
			describeFailures(failures)
	);
}

const WRAPPED = Symbol.for('owlat.test.scheduledFailureGate.wrapped');

/** Wrap console.error (once per console object) and register the per-test hooks. */
export function installScheduledFailureGate(): void {
	const state = gate();
	const current = console.error as typeof console.error & { [WRAPPED]?: true };
	if (!current[WRAPPED]) {
		const original = current.bind(console);
		const wrapped = (...args: unknown[]) => {
			recordConsoleError(args);
			original(...args);
		};
		console.error = Object.assign(wrapped, { [WRAPPED]: true as const });
	}

	beforeEach(() => {
		state.inTest = true;
		state.expected = [];
		state.failed = [];
	});
	afterEach(() => {
		state.inTest = false;
		throwIfAny(takeScheduledFailures(), 'during this test');
	});
	afterAll(() => {
		const orphaned = state.orphaned;
		state.orphaned = [];
		throwIfAny(orphaned, 'between tests in this file (a job an earlier test did not drain)');
	});
}
