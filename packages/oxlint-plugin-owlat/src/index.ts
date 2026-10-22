/**
 * oxlint plugin for Owlat's own rules, loaded by the root oxlintrc.json through
 * `jsPlugins`. oxlint imports this file from source (Node's type stripping), so
 * the plugin has no build step and every lint run uses the rules as written.
 */
import noInlineBackoff from './rules/noInlineBackoff.ts';
import noPollingLoopInTests from './rules/noPollingLoopInTests.ts';
import noRealTimeWaitInTests from './rules/noRealTimeWaitInTests.ts';
import noTestEnvironmentPragma from './rules/noTestEnvironmentPragma.ts';
import noTestInLoop from './rules/noTestInLoop.ts';
import noTestTimeoutOrUnreasonedSkip from './rules/noTestTimeoutOrUnreasonedSkip.ts';
import noWallClockInTests from './rules/noWallClockInTests.ts';
import requireSuppressionReason from './rules/requireSuppressionReason.ts';

export default {
	meta: { name: 'owlat' },
	rules: {
		'no-inline-backoff': noInlineBackoff,
		'no-polling-loop-in-tests': noPollingLoopInTests,
		'no-real-time-wait-in-tests': noRealTimeWaitInTests,
		'no-test-environment-pragma': noTestEnvironmentPragma,
		'no-test-in-loop': noTestInLoop,
		'no-test-timeout-or-unreasoned-skip': noTestTimeoutOrUnreasonedSkip,
		'no-wall-clock-in-tests': noWallClockInTests,
		'require-suppression-reason': requireSuppressionReason,
	},
};
