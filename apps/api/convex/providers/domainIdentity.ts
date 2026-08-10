/** Isolate-safe primary and relay domain-identity contributions. */
import { createHostedRelayIdentityProvider } from '../domains/providers/plugin';
import { mandrillProvider } from '../domains/providers/mandrill';
import { mtaProvider } from '../domains/providers/mta';
import type { RelayIdentityProviderModule } from '../domains/providers/relayIdentityTypes';
import { toRelayIdentityProvider } from '../domains/providers/relaySurface';
import { sesProvider } from '../domains/providers/ses';
import type {
	SendingDomainProviderKind,
	SendingDomainProviderModule,
} from '../domains/providers/types';
import { SEND_PROVIDER_CATALOG } from '../lib/sendProviders/catalog';
import {
	pluginSendTransportDomainIdentityFor,
	pluginSendTransportDomainIdentityKinds,
} from '../plugins/sendTransportDomainIdentityCatalog';

const primary = {
	mta: mtaProvider,
	ses: sesProvider,
	mandrill: mandrillProvider,
} as const satisfies {
	[K in SendingDomainProviderKind]: SendingDomainProviderModule<K>;
};

export const PRIMARY_DOMAIN_IDENTITY_PROVIDERS = Object.freeze(primary);

function coreRelayContributions(): RelayIdentityProviderModule[] {
	const result: RelayIdentityProviderModule[] = [];
	for (const kind of Object.keys(primary) as SendingDomainProviderKind[]) {
		const module = primary[kind] as SendingDomainProviderModule<SendingDomainProviderKind>;
		const relay = toRelayIdentityProvider(kind, module);
		if (relay) result.push(relay);
	}
	return result;
}

function thirdPartyRelayContributions(): RelayIdentityProviderModule[] {
	return pluginSendTransportDomainIdentityKinds().flatMap((kind) => {
		const identity = pluginSendTransportDomainIdentityFor(kind);
		return identity ? [createHostedRelayIdentityProvider(identity.definition)] : [];
	});
}

export const RELAY_DOMAIN_IDENTITY_PROVIDERS: ReadonlyMap<string, RelayIdentityProviderModule> =
	new Map(
		[...coreRelayContributions(), ...thirdPartyRelayContributions()].map((provider) => [
			provider.kind,
			provider,
		])
	);

// The catalog promise and executable contribution must agree in both directions.
for (const descriptor of SEND_PROVIDER_CATALOG) {
	const relay = RELAY_DOMAIN_IDENTITY_PROVIDERS.has(descriptor.kind);
	if ((descriptor.domainVerification === 'api') !== relay) {
		throw new TypeError(
			`Send provider '${descriptor.kind}' has inconsistent relay-domain identity metadata`
		);
	}
}
