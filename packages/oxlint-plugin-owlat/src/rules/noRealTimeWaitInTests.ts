import { isTestFile } from '../ast.ts';
import { fakeClock } from '../fakeClock.ts';
import type { Rule } from '../types.ts';
import { callWait, insideSleepHelper, promiseWait, type Wait } from '../waits.ts';

/**
 * A test never waits on the real clock. A sleep long enough to cover the slow
 * case wastes time on every fast run and still flakes on a loaded runner; the
 * test should await the event, promise or drained queue that marks the
 * milestone, or drive vitest's fake timers.
 *
 * Reported in test files (`*.test.*`, `*.spec.*`, anything under
 * `__tests__/`): a `new Promise` whose executor starts a timer with a delay
 * (`setTimeout(resolve, 50)`), a `node:timers/promises` timer, a call to a
 * helper named `sleep` / `delay`, Bun's `sleep` and Playwright's
 * `waitForTimeout`. A zero-delay timer only yields a tick and is left to
 * owlat/no-polling-loop-in-tests. A `sleep` helper's own body is not
 * reported, its calls are. A sleep on a global timer in a function that also
 * advances vitest's fake timers, with that timer faked, runs on fake time and
 * is allowed (see fakeClock.ts); `node:timers` imports, Bun's `sleep` and
 * Playwright's `waitForTimeout` stay real whatever vitest fakes.
 */

const MESSAGE =
	'Real-clock wait in a test: it costs its full delay on every run and still flakes under load. Await the event, promise or drained queue that marks the milestone, or drive fake timers (vi.useFakeTimers + vi.advanceTimersByTimeAsync).';

/** Cheap pre-check: a file that names none of these cannot hold a sleep. */
const MAY_SLEEP = /setTimeout|setInterval|sleep|delay|waitForTimeout|scheduler/u;

const rule: Rule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Disallow real-clock sleeps in tests; await the milestone or drive fake timers instead.',
		},
	},
	create(context) {
		if (!isTestFile(context.filename) || !MAY_SLEEP.test(context.sourceCode.text)) return {};
		const clock = fakeClock(context);
		const sleeps: Wait[] = [];
		const collect = (wait: Wait | undefined) => {
			if (wait?.kind === 'sleep' && !wait.viaHelper && !insideSleepHelper(wait.node)) {
				sleeps.push(wait);
			}
		};
		return {
			MemberExpression: clock.MemberExpression,
			NewExpression(node) {
				collect(promiseWait(context, node));
			},
			CallExpression(node) {
				collect(callWait(context, node, { sleepsOnly: true }));
			},
			'Program:exit'() {
				for (const { node, timer } of sleeps) {
					if (timer === undefined || !clock.drivesTimer(node, timer)) {
						context.report({ node, message: MESSAGE });
					}
				}
			},
		};
	},
};

export default rule;
