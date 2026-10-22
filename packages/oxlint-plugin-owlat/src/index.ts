/**
 * oxlint plugin for Owlat's own rules, loaded by the root oxlintrc.json through
 * `jsPlugins`. oxlint imports this file from source (Node's type stripping), so
 * the plugin has no build step and every lint run uses the rules as written.
 */
import noDocumentBodyReset from './rules/noDocumentBodyReset.ts';
import noTestEnvironmentPragma from './rules/noTestEnvironmentPragma.ts';
import noTestInLoop from './rules/noTestInLoop.ts';
import requireSuppressionReason from './rules/requireSuppressionReason.ts';

export default {
	meta: { name: 'owlat' },
	rules: {
		'no-document-body-reset': noDocumentBodyReset,
		'no-test-environment-pragma': noTestEnvironmentPragma,
		'no-test-in-loop': noTestInLoop,
		'require-suppression-reason': requireSuppressionReason,
	},
};
