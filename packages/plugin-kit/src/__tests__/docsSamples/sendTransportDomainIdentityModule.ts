// #region send-transport-domain-identity-module
import type {
	PluginDomainIdentityResult,
	PluginSendTransportDomainIdentityModule,
} from '@owlat/plugin-kit';

/** Observations ONLY: the host derives the status and owns the freshness bound. */
export const domainIdentity: PluginSendTransportDomainIdentityModule = {
	// The credential comes from the resolved configuration, never from
	// `process.env`: an environment read resolves the deployment-default instance
	// whichever instance the host meant.
	registerDomain: (domain, config) => askProvider('POST', domain, config.env['PLUGIN_ACME_TOKEN']),
	checkDomain: (domain, config) => askProvider('GET', domain, config.env['PLUGIN_ACME_TOKEN']),
};

async function askProvider(
	method: 'GET' | 'POST',
	domain: string,
	token: string | undefined
): Promise<PluginDomainIdentityResult> {
	const response = await fetch(`https://api.example.net/domains/${domain}`, {
		method,
		headers: { Authorization: `Bearer ${token ?? ''}` },
	});
	// Three distinguishable answers, because the host writes each one differently:
	// only `ok` refreshes the proof's age, and only `auth_failed` condemns a key.
	if (response.status === 401 || response.status === 403) {
		return { outcome: 'auth_failed', error: 'the provider rejected the token' };
	}
	if (!response.ok) return { outcome: 'unavailable', error: `HTTP ${response.status}` };
	const body = (await response.json()) as {
		readonly owned?: boolean;
		readonly spf?: boolean;
		readonly dkim?: boolean;
		readonly selector?: string;
	};
	return {
		outcome: 'ok',
		state: {
			isOwnershipVerified: body.owned === true,
			spf: { isValid: body.spf === true },
			dkim: { isValid: body.dkim === true },
			dkimSelectors: body.selector ? [body.selector] : [],
			spfMechanisms: ['include:spf.example.net'],
		},
	};
}
// #endregion send-transport-domain-identity-module
