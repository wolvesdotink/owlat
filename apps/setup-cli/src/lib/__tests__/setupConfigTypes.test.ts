/**
 * setup-cli parses the config the desktop wizard writes. The types live in
 * `@owlat/shared/setupConfigTypes` so both halves share one declaration; this
 * module re-exports them for its own importers. Pin that the re-exports are the
 * shared types, and that a config typed against them parses.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as Shared from '@owlat/shared/setupConfigTypes';
import {
	parseSetupConfig,
	type AiConfig,
	type DeploymentMode,
	type SendingConfig,
	type SetupConfig,
} from '../setupConfig';

describe('setup config contract types', () => {
	it('re-exports the shared declarations unchanged', () => {
		expectTypeOf<SetupConfig>().toEqualTypeOf<Shared.SetupConfig>();
		expectTypeOf<SendingConfig>().toEqualTypeOf<Shared.SendingConfig>();
		expectTypeOf<AiConfig>().toEqualTypeOf<Shared.AiConfig>();
		expectTypeOf<DeploymentMode>().toEqualTypeOf<Shared.DeploymentMode>();
	});

	it('parses a config typed against the shared contract', () => {
		const config: Shared.SetupConfig = {
			version: 1,
			deploymentMode: 'selfhost',
			features: { packs: { emailClient: true, marketing: true, ai: false } },
			sending: { provider: 'mta' },
			admin: { email: 'admin@owlat.test', name: 'Admin', password: 'correct-horse-battery' },
		};
		expect(parseSetupConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
	});
});
