/**
 * oxlint plugin for Owlat's own rules, loaded by the root oxlintrc.json through
 * `jsPlugins`. oxlint imports this file from source (Node's type stripping), so
 * the plugin has no build step and every lint run uses the rules as written.
 */
import convexErrorTaxonomy from './rules/convexErrorTaxonomy.ts';
import featureFloorInBuilder from './rules/featureFloorInBuilder.ts';
import noCryptoPrimitives from './rules/noCryptoPrimitives.ts';
import noLogPii from './rules/noLogPii.ts';
import noProcessEnv from './rules/noProcessEnv.ts';
import noRawConvexBuilder from './rules/noRawConvexBuilder.ts';
import noTestEnvironmentPragma from './rules/noTestEnvironmentPragma.ts';
import noTestInLoop from './rules/noTestInLoop.ts';
import requireSuppressionReason from './rules/requireSuppressionReason.ts';
import useThreadedSession from './rules/useThreadedSession.ts';

export default {
	meta: { name: 'owlat' },
	rules: {
		'convex-error-taxonomy': convexErrorTaxonomy,
		'feature-floor-in-builder': featureFloorInBuilder,
		'no-crypto-primitives': noCryptoPrimitives,
		'no-log-pii': noLogPii,
		'no-process-env': noProcessEnv,
		'no-raw-convex-builder': noRawConvexBuilder,
		'no-test-environment-pragma': noTestEnvironmentPragma,
		'no-test-in-loop': noTestInLoop,
		'require-suppression-reason': requireSuppressionReason,
		'use-threaded-session': useThreadedSession,
	},
};
