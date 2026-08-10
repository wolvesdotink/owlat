// @vitest-environment happy-dom
/**
 * The web half of plugin send-provider parity (seams-plan A4).
 *
 * Plugin codegen emits the same data-only transport catalog into API and web.
 * This suite supplies the conformance fixture's descriptor shape at that build
 * boundary and proves it reaches every operator-facing credential operation:
 * picker, blank form, required-field gate, env patch, and generic apply body.
 */

import { describe, expect, it, vi } from 'vitest';

const { PLUGIN_KIND, PLUGIN_TOKEN_ENV, pluginCatalog } = vi.hoisted(() => {
	const kind = 'plugin.mock-esp.relay';
	const tokenEnv = 'PLUGIN_MOCK_ESP_TOKEN';
	return {
		PLUGIN_KIND: kind,
		PLUGIN_TOKEN_ENV: tokenEnv,
		pluginCatalog: Object.freeze([
			Object.freeze({
				kind,
				pluginId: 'mock-esp',
				localId: 'relay',
				label: 'Mock ESP',
				retryDelays: Object.freeze([1_000]),
				requiredEnvVars: Object.freeze([tokenEnv]),
				domainVerification: 'api',
				credentialFields: Object.freeze([
					Object.freeze({
						kind: 'secret',
						key: 'token',
						label: 'API token',
						required: true,
						envVar: tokenEnv,
					}),
				]),
				requiredCapability: 'send:transport',
			}),
		]),
	};
});

vi.mock('~/generated/sendTransportCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: pluginCatalog,
}));

import {
	credentialFieldsFor,
	requiredCredentialError,
	seedCredentialValues,
	transportCredentialEnv,
} from '../setupWizardCredentials';
import { buildProviderEnv, type EmailStepDraft } from '../useSetupWizard';
import { RELAY_PROVIDER_OPTIONS, useRelayCredentialDraft } from '../useRelayCredentialDraft';
import { mount } from '@vue/test-utils';
import TransportCredentialFields from '../../components/delivery/TransportCredentialFields.vue';
import { wizardStubs } from '../../components/delivery/__tests__/wizardHarness';
import { transportDnsGuidance } from '../../utils/transportDnsGuidance';

function draft(): EmailStepDraft {
	return {
		provider: PLUGIN_KIND,
		requiresProvider: true,
		resendKey: '',
		mandrillKey: '',
		ses: { region: '', accessKeyId: '', secretAccessKey: '' },
		smtp: { preset: 'custom', host: '', port: '', secure: false, username: '', password: '' },
		fromEmail: '',
		fromName: '',
	};
}

describe('a bundled plugin transport reaches the credential UI', () => {
	it('is offered by the picker under its generated label', () => {
		expect(RELAY_PROVIDER_OPTIONS).toContainEqual(
			expect.objectContaining({ value: PLUGIN_KIND, label: 'Mock ESP' })
		);
	});

	it('renders capability-derived DNS guidance from the composed entry', () => {
		expect(transportDnsGuidance(PLUGIN_KIND)).toEqual(
			expect.objectContaining({
				label: 'Mock ESP',
				lead: expect.stringContaining('identity API'),
			})
		);
	});

	it('renders and seeds its generated write-only descriptor', () => {
		expect(credentialFieldsFor(PLUGIN_KIND)).toEqual([
			expect.objectContaining({ kind: 'secret', envVar: PLUGIN_TOKEN_ENV, required: true }),
		]);
		expect(seedCredentialValues(PLUGIN_KIND)).toEqual({ [PLUGIN_TOKEN_ENV]: '' });

		const wrapper = mount(TransportCredentialFields, {
			props: {
				kind: PLUGIN_KIND,
				values: seedCredentialValues(PLUGIN_KIND),
				preset: 'custom',
				presetOptions: [],
			},
			global: { stubs: wizardStubs },
		});
		expect(wrapper.text()).toContain('API token');
		expect(wrapper.find('input').attributes('type')).toBe('password');
	});

	it('gates a missing required value and clears the error once supplied', () => {
		expect(requiredCredentialError(PLUGIN_KIND, {})).toBe('Enter api token.');
		expect(
			requiredCredentialError(PLUGIN_KIND, { [PLUGIN_TOKEN_ENV]: 'tok-live' })
		).toBeUndefined();

		const relay = useRelayCredentialDraft(PLUGIN_KIND);
		expect(relay.requiredCredentialError.value).toBe('Enter api token.');
		relay.credentialValues[PLUGIN_TOKEN_ENV] = 'tok-live';
		expect(relay.requiredCredentialError.value).toBeUndefined();
	});

	it('writes only the declared variable and carries it into the generic apply patch', () => {
		const values = { [PLUGIN_TOKEN_ENV]: 'tok-live', INSTANCE_SECRET: 'must-not-pass' };
		expect(transportCredentialEnv(PLUGIN_KIND, values)).toEqual({
			[PLUGIN_TOKEN_ENV]: 'tok-live',
		});
		expect(buildProviderEnv({}, draft(), values)).toEqual({
			EMAIL_PROVIDER: PLUGIN_KIND,
			[PLUGIN_TOKEN_ENV]: 'tok-live',
		});
	});
});
