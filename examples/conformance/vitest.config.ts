import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The gallery drives the real packages from source, not from build output, so a
 * contract change is caught here in the same commit that makes it. Aliases point
 * at each package's checked-in entry (build wiring, not module imports — see
 * scripts/check-cross-package-imports.sh).
 */
export default defineConfig({
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
		// The lifecycle suite runs the real codegen against throwaway workspaces,
		// which spawns the atomic-commit helper per generated file.
		testTimeout: 60_000,
	},
	resolve: {
		alias: {
			'@owlat/plugin-kit': resolve(__dirname, '../../packages/plugin-kit/src/index.ts'),
			'@owlat/shared/featureFlags': resolve(__dirname, '../../packages/shared/src/featureFlags.ts'),
			'@owlat/plugin-host': resolve(__dirname, '../../packages/plugin-host/src/index.ts'),
			'@owlat/plugin-codegen': resolve(__dirname, '../../packages/plugin-codegen/src/index.ts'),
			'@owlat/plugin-cli/run': resolve(__dirname, '../../packages/plugin-cli/src/run.ts'),
			'@owlat/example-deliverability-lab': resolve(
				__dirname,
				'../plugins/deliverability-lab/src/index.ts'
			),
			'@owlat/example-escalation-guard': resolve(
				__dirname,
				'../plugins/escalation-guard/src/index.ts'
			),
			'@owlat/code-worker/jobs/seedTest': resolve(
				__dirname,
				'../../apps/code-worker/src/jobs/seedTest.ts'
			),
			'@owlat/code-worker/pluginTaskRunner': resolve(
				__dirname,
				'../../apps/code-worker/src/pluginTaskRunner.ts'
			),
			'@owlat/example-slack-approvals': resolve(
				__dirname,
				'../plugins/slack-approvals/src/index.ts'
			),
		},
	},
});
