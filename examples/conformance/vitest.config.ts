import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { PARALLEL_GATE_TIMEOUT_MS } from '../../vitest.timeouts';

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
		// which spawns the atomic-commit helper per generated file. That fixed cost
		// inflates under the root gate's full parallelism, so take the shared budget
		// rather than a local literal (see vitest.timeouts.ts).
		testTimeout: PARALLEL_GATE_TIMEOUT_MS,
		hookTimeout: PARALLEL_GATE_TIMEOUT_MS,
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
			// ── The parity proof's core surface (P3.3) ──────────────────────────
			//
			// `pluginProviderParity.test.ts` drives the SHIPPED routing, dispatch,
			// ramp-attribution, return-path and credential-form modules against a
			// fixture plugin ESP, so it has to reach into `apps/api` and `apps/web`
			// exactly as the replay suite already reaches into `apps/code-worker`.
			// Aliases rather than relative climbs, per
			// `scripts/check-cross-package-imports.sh`: this is build wiring.
			//
			// NO ALIAS MAY PREFIX ANOTHER. Vite matches a string `find` with
			// `startsWith`, so a generated artifact aliased as
			// `…/plugins/sendTransportWebhookCatalog.generated` would be captured by
			// the host module's own `…/plugins/sendTransportWebhookCatalog` entry
			// whenever it sorted first. The generated artifacts therefore live under
			// their own `@owlat/api/generated/…` segment, which cannot collide.
			'@owlat/api/generated/sendTransportCatalog': resolve(
				__dirname,
				'../../apps/api/convex/plugins/sendTransportCatalog.generated.ts'
			),
			'@owlat/api/generated/sendTransportModules': resolve(
				__dirname,
				'../../apps/api/convex/plugins/sendTransportModules.generated.ts'
			),
			'@owlat/api/generated/plugins': resolve(
				__dirname,
				'../../apps/api/convex/plugins/plugins.generated.ts'
			),
			'@owlat/api/sendProviders/dispatch': resolve(
				__dirname,
				'../../apps/api/convex/lib/sendProviders/dispatch.ts'
			),
			'@owlat/api/generated/sendTransportWebhookCatalog': resolve(
				__dirname,
				'../../apps/api/convex/plugins/sendTransportWebhookCatalog.generated.ts'
			),
			'@owlat/api/generated/sendTransportWebhookModules': resolve(
				__dirname,
				'../../apps/api/convex/plugins/sendTransportWebhookModules.generated.ts'
			),
			'@owlat/api/generated/sendTransportDomainIdentityCatalog': resolve(
				__dirname,
				'../../apps/api/convex/plugins/sendTransportDomainIdentityCatalog.generated.ts'
			),
			'@owlat/api/generated/sendTransportDomainIdentityModules': resolve(
				__dirname,
				'../../apps/api/convex/plugins/sendTransportDomainIdentityModules.generated.ts'
			),
			'@owlat/api/plugins/sendTransportWebhookCatalog': resolve(
				__dirname,
				'../../apps/api/convex/plugins/sendTransportWebhookCatalog.ts'
			),
			'@owlat/api/plugins/sendTransportDomainIdentityCatalog': resolve(
				__dirname,
				'../../apps/api/convex/plugins/sendTransportDomainIdentityCatalog.ts'
			),
			'@owlat/api/plugins/inboundSignature': resolve(
				__dirname,
				'../../apps/api/convex/plugins/inboundSignature.ts'
			),
			'@owlat/api/sendProviders/catalog': resolve(
				__dirname,
				'../../apps/api/convex/lib/sendProviders/catalog.ts'
			),
			'@owlat/api/sendProviders/routing': resolve(
				__dirname,
				'../../apps/api/convex/lib/sendProviders/routing.ts'
			),
			'@owlat/api/sendProviders/fallbackEligibility': resolve(
				__dirname,
				'../../apps/api/convex/lib/sendProviders/fallbackEligibility.ts'
			),
			'@owlat/api/sendProviders/returnPathCapability': resolve(
				__dirname,
				'../../apps/api/convex/lib/sendProviders/returnPathCapability.ts'
			),
			'@owlat/api/delivery/sendAssignments': resolve(
				__dirname,
				'../../apps/api/convex/delivery/sendAssignments.ts'
			),
			'@owlat/api/domains/pluginRelayState': resolve(
				__dirname,
				'../../apps/api/convex/domains/providers/plugin/state.ts'
			),
			'@owlat/api/webhooks/pluginFeedbackEvents': resolve(
				__dirname,
				'../../apps/api/convex/webhooks/pluginFeedbackEvents.ts'
			),
		},
	},
});
