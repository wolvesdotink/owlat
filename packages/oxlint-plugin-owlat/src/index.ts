/**
 * oxlint plugin for Owlat's own rules, loaded by the root oxlintrc.json through
 * `jsPlugins`. oxlint imports this file from source (Node's type stripping), so
 * the plugin has no build step and every lint run uses the rules as written.
 */
import convexErrorTaxonomy from './rules/convexErrorTaxonomy.ts';
import featureFloorInBuilder from './rules/featureFloorInBuilder.ts';
import noCryptoPrimitives from './rules/noCryptoPrimitives.ts';
import noLogPii from './rules/noLogPii.ts';
import noPollingLoopInTests from './rules/noPollingLoopInTests.ts';
import noProcessEnv from './rules/noProcessEnv.ts';
import noRawConvexBuilder from './rules/noRawConvexBuilder.ts';
import noRealTimeWaitInTests from './rules/noRealTimeWaitInTests.ts';
import noTestEnvironmentPragma from './rules/noTestEnvironmentPragma.ts';
import noTestInLoop from './rules/noTestInLoop.ts';
import noTestTimeoutOrUnreasonedSkip from './rules/noTestTimeoutOrUnreasonedSkip.ts';
import noWallClockInTests from './rules/noWallClockInTests.ts';
import requireSuppressionReason from './rules/requireSuppressionReason.ts';
import useThreadedSession from './rules/useThreadedSession.ts';

export default {
	meta: { name: 'owlat' },
	rules: {
		'convex-error-taxonomy': convexErrorTaxonomy,
		'feature-floor-in-builder': featureFloorInBuilder,
		'no-crypto-primitives': noCryptoPrimitives,
		'no-log-pii': noLogPii,
		'no-polling-loop-in-tests': noPollingLoopInTests,
		'no-process-env': noProcessEnv,
		'no-raw-convex-builder': noRawConvexBuilder,
		'no-real-time-wait-in-tests': noRealTimeWaitInTests,
		'no-test-environment-pragma': noTestEnvironmentPragma,
		'no-test-in-loop': noTestInLoop,
		'no-test-timeout-or-unreasoned-skip': noTestTimeoutOrUnreasonedSkip,
		'no-wall-clock-in-tests': noWallClockInTests,
		'require-suppression-reason': requireSuppressionReason,
		'use-threaded-session': useThreadedSession,
	},
};
