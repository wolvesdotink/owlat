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
			// The scaffold GENERATOR, for P3.4's conformance gate: the emitted
			// send-provider bundle is driven through the shipped core modules, so the
			// generator has to be called rather than its output copied.
			'@owlat/plugin-cli/scaffold': resolve(__dirname, '../../packages/plugin-cli/src/scaffold.ts'),
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
			// fixture plugin ESP, so it has to reach into `apps/api` exactly as the
			// replay suite already reaches into `apps/code-worker`. Aliases rather than
			// relative climbs, per `scripts/check-cross-package-imports.sh`: this is
			// build wiring.
			//
			// THERE IS NO `apps/web` ALIAS, and that is a choice rather than an
			// omission: the web half of the proof needs Nuxt's auto-imports, which do
			// not resolve under this config, so it is pinned in `apps/web`'s own suite
			// (`app/composables/__tests__/pluginTransportCredentialGap.test.ts`). What
			// this suite reads of the UI vocabulary it reads from `@owlat/shared`.
			//
			// THE ALIASES ARE NOT THE DEPENDENCY. `@owlat/api` and `@owlat/shared` are
			// declared in this package's `devDependencies` as well, because Turborepo
			// builds its `--affected` graph from package.json and CI selects PR test
			// jobs from it: without the declaration, a PR that changes only
			// `lib/sendProviders/routing.ts` would not select this workspace and the
			// standing regression harness would replay a cached green.
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
			// The adapter vocabulary, for the typed `EmailErrorCode` the fail-closed
			// dispatch cases assert: `success: false` alone cannot tell a host refusal
			// from a swallowed throw.
			'@owlat/api/sendProviders/types': resolve(
				__dirname,
				'../../apps/api/convex/lib/sendProviders/types.ts'
			),
			'@owlat/api/sendProviders/routing': resolve(
				__dirname,
				'../../apps/api/convex/lib/sendProviders/routing.ts'
			),
			// The strategy registry, so "under every strategy" is derived from the
			// registry rather than from a list of four names in the suite.
			'@owlat/api/sendProviders/strategies': resolve(
				__dirname,
				'../../apps/api/convex/lib/sendProviders/strategies/index.ts'
			),
			// The provider registry (`lib/sendProviders/index.ts`), for the governed
			// boundary's extras seam. Named `registry` rather than `index` so no alias
			// key prefixes another — see the note above.
			'@owlat/api/sendProviders/registry': resolve(
				__dirname,
				'../../apps/api/convex/lib/sendProviders/index.ts'
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
