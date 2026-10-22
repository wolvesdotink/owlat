/**
 * oxlint plugin for Owlat's own rules, loaded by the root oxlintrc.json through
 * `jsPlugins`. oxlint imports this file from source (Node's type stripping), so
 * the plugin has no build step and every lint run uses the rules as written.
 */
import noTestEnvironmentPragma from './rules/noTestEnvironmentPragma.ts';
import noTestInLoop from './rules/noTestInLoop.ts';
import noTestTimeoutOrUnreasonedSkip from './rules/noTestTimeoutOrUnreasonedSkip.ts';
import requireSuppressionReason from './rules/requireSuppressionReason.ts';

export default {
	meta: { name: 'owlat' },
	rules: {
		'no-test-environment-pragma': noTestEnvironmentPragma,
		'no-test-in-loop': noTestInLoop,
		'no-test-timeout-or-unreasoned-skip': noTestTimeoutOrUnreasonedSkip,
		'require-suppression-reason': requireSuppressionReason,
	},
};
