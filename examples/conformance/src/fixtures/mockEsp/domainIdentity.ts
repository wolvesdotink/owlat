/**
 * MOCK ESP — the SENDING-DOMAIN IDENTITY half of the bundle.
 *
 * OBSERVATIONS, NEVER A VERDICT. The module reports what the provider currently
 * sees — ownership, the two record verdicts, the DKIM selectors it signs under
 * and the SPF mechanisms it needs authorised — and the HOST derives `verified`
 * from those. There is no `status` field to return, which is what makes it
 * impossible for a relay to report a domain verified while telling us its DKIM
 * record is invalid.
 *
 * The three outcomes are distinguished on purpose: only `ok` refreshes the
 * proof's age, only `auth_failed` condemns a credential, and `unavailable` (the
 * answer a thrown error is also read as) changes nothing but the retry.
 *
 * Isolate-safe, like the webhook half: `domains/providers/` imports the
 * generated registry on the enqueue path.
 */

import type {
	PluginDomainIdentityResult,
	PluginSendTransportConfig,
	PluginSendTransportDomainIdentityModule,
} from '@owlat/plugin-kit';
// The name the MANIFEST declares, read from the one module that declares it.
import { MOCK_ESP_TOKEN_ENV } from './envNames';

/** The selector this fixture's provider signs every registered domain under. */
export const MOCK_ESP_DKIM_SELECTOR = 'mockesp';

/** The include this fixture's provider needs on a domain's SPF record. */
export const MOCK_ESP_SPF_MECHANISM = 'include:spf.mock-esp.example';

/** Domains the fixture provider has been asked to register, in call order. */
const REGISTERED: string[] = [];

export function mockEspRegisteredDomains(): readonly string[] {
	return REGISTERED;
}

export function resetMockEspRegisteredDomains(): void {
	REGISTERED.length = 0;
}

/**
 * The provider's imagined rule, so the fixture can produce each of the host's
 * three derived statuses without a knob the host would have to know about: a
 * domain registered here is fully observed; `pending.*` is registered but has
 * not published its DKIM; `unknown.*` was never registered at all.
 */
function observe(domain: string): PluginDomainIdentityResult {
	if (domain.startsWith('unknown.')) {
		return {
			outcome: 'ok',
			state: {
				isOwnershipVerified: false,
				spf: { isValid: false, error: 'no identity at this account' },
				dkim: { isValid: false, error: 'no identity at this account' },
				dkimSelectors: [],
				spfMechanisms: [],
			},
		};
	}
	const isPublished = !domain.startsWith('pending.');
	return {
		outcome: 'ok',
		state: {
			isOwnershipVerified: true,
			spf: isPublished ? { isValid: true } : { isValid: false, error: 'SPF not published yet' },
			dkim: isPublished ? { isValid: true } : { isValid: false, error: 'DKIM not published yet' },
			dkimSelectors: [MOCK_ESP_DKIM_SELECTOR],
			spfMechanisms: [MOCK_ESP_SPF_MECHANISM],
		},
	};
}

export const mockEspDomainIdentity: PluginSendTransportDomainIdentityModule = {
	async registerDomain(
		domain: string,
		config: PluginSendTransportConfig
	): Promise<PluginDomainIdentityResult> {
		// Credentials come from the instance configuration, never the environment:
		// an environment read would resolve the deployment-default instance's token
		// whichever instance the caller meant.
		if (!config.env[MOCK_ESP_TOKEN_ENV]) {
			return { outcome: 'auth_failed', error: 'no API token for this instance' };
		}
		REGISTERED.push(domain);
		return observe(domain);
	},

	async checkDomain(
		domain: string,
		config: PluginSendTransportConfig
	): Promise<PluginDomainIdentityResult> {
		if (!config.env[MOCK_ESP_TOKEN_ENV]) {
			return { outcome: 'auth_failed', error: 'no API token for this instance' };
		}
		return observe(domain);
	},
};
