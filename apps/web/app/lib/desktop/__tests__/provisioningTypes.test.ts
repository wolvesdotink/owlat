/**
 * The desktop wizard writes a setup config that setup-cli parses on the target
 * host, and drives the native SSH bridge through `ProvisionTransport`. Both
 * contracts are imported, not restated, so a field rename on either side is a
 * compile error here rather than a failed install over SSH. These checks pin
 * that: the `@ts-expect-error` lines fail the typecheck if the wizard's config
 * type ever loosens back to `Record<string, boolean>`.
 */
import { describe, expectTypeOf, it } from 'vitest';
import type * as SshBridge from '@owlat/desktop/src/ssh';
import type * as SharedSetupConfig from '@owlat/shared/setupConfigTypes';
import type {
	ConnectInfo,
	ExecEvent,
	SendingConfig,
	SetupConfigInput,
	SshAuth,
} from '../provisioning';

describe('provisioning contract types', () => {
	it('re-exports the SSH bridge types instead of restating them', () => {
		expectTypeOf<ConnectInfo>().toEqualTypeOf<SshBridge.ConnectInfo>();
		expectTypeOf<SshAuth>().toEqualTypeOf<SshBridge.SshAuth>();
		expectTypeOf<ExecEvent>().toEqualTypeOf<SshBridge.ExecEvent>();
	});

	it("writes setup-cli's SetupConfig, not a copy of it", () => {
		expectTypeOf<SetupConfigInput>().toEqualTypeOf<SharedSetupConfig.SetupConfig>();
		expectTypeOf<SendingConfig>().toEqualTypeOf<SharedSetupConfig.SendingConfig>();
	});

	it('rejects a misspelled pack or flag key at compile time', () => {
		const packs: SetupConfigInput['features'] = {
			// @ts-expect-error — not a FeaturePackKey
			packs: { emailClinet: true },
		};
		const flags: SetupConfigInput['features'] = {
			// @ts-expect-error — not a feature flag key
			flags: { 'mail.externl': true },
		};
		expectTypeOf(packs).toEqualTypeOf<SetupConfigInput['features']>();
		expectTypeOf(flags).toEqualTypeOf<SetupConfigInput['features']>();
	});

	it('offers every sending provider setup-cli accepts in the type', () => {
		expectTypeOf<'emailit'>().toMatchTypeOf<SendingConfig['provider']>();
		expectTypeOf<'smtp'>().toMatchTypeOf<SendingConfig['provider']>();
	});
});
