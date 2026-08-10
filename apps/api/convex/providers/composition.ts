'use node';

/**
 * The single runtime composition of every outbound provider contribution.
 *
 * Catalog data remains isolate-safe in `lib/sendProviders/catalog`; this module
 * joins that data to executable transport and optional capability modules. The
 * join is deterministic and runs at module load, so a broken bundle prevents a
 * deployment instead of surfacing on the first real send.
 */
import {
	composeProviderBundles,
	type ComposedSendProviderBundle,
	type SendProviderBundle,
} from '@owlat/provider-kit';
import { OWN_SEND_PROVIDER_KIND } from '@owlat/shared/sendProviderCatalog';
import type { SendProviderCatalogEntry } from '../lib/sendProviders/catalogTypes';
import {
	SEND_PROVIDER_CATALOG,
	isCoreSendProviderKind,
	sendProviderCatalogEntry,
} from '../lib/sendProviders/catalog';
import { emailitSendProvider } from '../lib/sendProviders/emailit';
import { mandrillSendProvider } from '../lib/sendProviders/mandrill';
import { mtaSendProvider } from '../lib/sendProviders/mta';
import {
	createHostedSendProvider,
	type HostedSendProviderModule,
} from '../lib/sendProviders/pluginProvider';
import { resendSendProvider } from '../lib/sendProviders/resend';
import { sesSendProvider } from '../lib/sendProviders/ses';
import { smtpSendProvider } from '../lib/sendProviders/smtp';
import type {
	CoreSendProviderKind,
	SendProviderKind,
	SendProviderModule,
} from '../lib/sendProviders/types';
import { BUNDLED_PLUGIN_SEND_TRANSPORT_MODULES } from '../plugins/sendTransportModules.generated';
import { pluginSendTransportDomainIdentityFor } from '../plugins/sendTransportDomainIdentityCatalog';
import { providerFeedbackFor } from './feedback';
import {
	PRIMARY_DOMAIN_IDENTITY_PROVIDERS,
	RELAY_DOMAIN_IDENTITY_PROVIDERS,
} from './domainIdentity';

type RuntimeTransport = SendProviderModule<SendProviderKind> | HostedSendProviderModule;

export interface RuntimeProviderBundle extends ComposedSendProviderBundle<
	SendProviderKind,
	RuntimeTransport,
	unknown
> {
	readonly descriptor: SendProviderCatalogEntry;
}

const CORE_TRANSPORTS = {
	mta: mtaSendProvider,
	ses: sesSendProvider,
	resend: resendSendProvider,
	smtp: smtpSendProvider,
	mandrill: mandrillSendProvider,
	emailit: emailitSendProvider,
} as const satisfies { [K in CoreSendProviderKind]: SendProviderModule<K> };

const platformHooks = new Map<string, { readonly exportPath: string }>([
	[OWN_SEND_PROVIDER_KIND, { exportPath: 'providers/mta/platformHooks' }],
]);

function coreBundle<K extends CoreSendProviderKind>(
	kind: K
): SendProviderBundle<K, RuntimeTransport, unknown> {
	const descriptor = sendProviderCatalogEntry(kind) as SendProviderCatalogEntry & { kind: K };
	const feedback = providerFeedbackFor(kind);
	const primaryDomainIdentity =
		PRIMARY_DOMAIN_IDENTITY_PROVIDERS[kind as keyof typeof PRIMARY_DOMAIN_IDENTITY_PROVIDERS];
	const relayDomainIdentity = RELAY_DOMAIN_IDENTITY_PROVIDERS.get(kind);
	const hooks = platformHooks.get(kind);
	const bundle: SendProviderBundle<K, RuntimeTransport, unknown> = {
		descriptor,
		transport: CORE_TRANSPORTS[kind],
		...(feedback ? { feedback } : {}),
		...(primaryDomainIdentity
			? { primaryDomainIdentity: { exportPath: `domains/providers/${primaryDomainIdentity.kind}` } }
			: {}),
		...(relayDomainIdentity
			? { relayDomainIdentity: { exportPath: `domains/providers/${relayDomainIdentity.kind}` } }
			: {}),
		...(descriptor.setupProbe
			? {
					setup: {
						probe: { exportPath: `@owlat/shared/${descriptor.setupProbe.validator}` },
						ceremony: descriptor.providerFeedback?.setupPanel ?? 'none',
					},
				}
			: descriptor.providerFeedback?.setupPanel
				? { setup: { ceremony: descriptor.providerFeedback.setupPanel } }
				: {}),
		...(hooks ? { platformHooks: hooks } : {}),
	};
	return bundle;
}

interface GeneratedSendTransportModule {
	readonly kind: SendProviderKind;
	readonly pluginId: string;
	readonly module: unknown;
}

/**
 * THE MODULES ARTIFACT IS RE-VALIDATED, and for the reason `catalog.ts` states
 * over its own generated half: the ARTIFACT — not the manifest the codegen read
 * — is what this deployment actually runs, so a hand edit, a bad merge or a
 * partial regeneration ends at an entry no validator ever saw. Both mistakes
 * this refuses would otherwise be SILENT rather than loud:
 *
 *   - a module claiming a CORE kind is ignored, because a core kind is joined to
 *     `CORE_TRANSPORTS` and never consults this artifact — so the entry would sit
 *     in the bundle claiming to own `mta` while nothing read it;
 *   - a DUPLICATED kind is resolved last-write-wins by `new Map`, so one of the
 *     two contributing plugins would silently lose the transport it owns.
 *
 * A deployment mistake must stop the deployment, which is why this throws at
 * module load beside the `has no owned module` join below rather than degrading.
 */
function ownedModulesByKind(
	entries: readonly GeneratedSendTransportModule[]
): ReadonlyMap<SendProviderKind, GeneratedSendTransportModule> {
	const byKind = new Map<SendProviderKind, GeneratedSendTransportModule>();
	for (const entry of entries) {
		if (isCoreSendProviderKind(entry.kind)) {
			throw new TypeError(`Bundled send transport '${entry.kind}' may not claim a core kind`);
		}
		if (byKind.has(entry.kind)) {
			throw new TypeError(`Bundled send transport '${entry.kind}' has more than one owned module`);
		}
		byKind.set(entry.kind, entry);
	}
	return byKind;
}

const generatedModules = ownedModulesByKind(
	BUNDLED_PLUGIN_SEND_TRANSPORT_MODULES as readonly GeneratedSendTransportModule[]
);

function pluginBundle(
	descriptor: SendProviderCatalogEntry
): SendProviderBundle<string, HostedSendProviderModule, unknown> {
	const generated = generatedModules.get(descriptor.kind);
	if (!generated || generated.pluginId !== descriptor.pluginId) {
		throw new TypeError(`Bundled send transport '${descriptor.kind}' has no owned module`);
	}
	const instanceEnvVars = descriptor.instanceEnvVars ?? [];
	const transport = createHostedSendProvider(
		descriptor.kind as never,
		descriptor.retryDelays,
		generated.module,
		{
			instanceEnvVars,
			requiredEnvVars: descriptor.requiredEnvVars.filter((name) => instanceEnvVars.includes(name)),
		}
	);
	if (descriptor.deduplicatesOnIdempotencyKey === true && !transport.buildSystemMailExtras) {
		throw new TypeError(
			`Bundled send transport '${descriptor.kind}' declares deduplicatesOnIdempotencyKey: true without buildSystemMailExtras. See PluginSendTransportModule in packages/plugin-kit/src/sendTransport.ts`
		);
	}
	const feedback = providerFeedbackFor(descriptor.kind);
	const identity = pluginSendTransportDomainIdentityFor(descriptor.kind);
	return {
		descriptor,
		transport,
		...(feedback ? { feedback } : {}),
		...(identity ? { relayDomainIdentity: identity.module } : {}),
	};
}

const assigned = SEND_PROVIDER_CATALOG.map((descriptor) => {
	if (isCoreSendProviderKind(descriptor.kind)) {
		return {
			source: descriptor.tier === 'own' ? ('own' as const) : ('first-party' as const),
			bundle: coreBundle(descriptor.kind),
		};
	}
	return { source: 'third-party' as const, bundle: pluginBundle(descriptor) };
});

export const SEND_PROVIDER_BUNDLES = composeProviderBundles(
	assigned
) as readonly RuntimeProviderBundle[];

const byKind: ReadonlyMap<string, RuntimeProviderBundle> = new Map(
	SEND_PROVIDER_BUNDLES.map((bundle) => [bundle.descriptor.kind, bundle])
);

export function providerBundleFor(kind: string): RuntimeProviderBundle | undefined {
	return byKind.get(kind);
}

export function runtimeTransportFor(kind: SendProviderKind): RuntimeTransport {
	const transport = byKind.get(kind)?.transport;
	if (!transport || ('exportPath' in transport && typeof transport.exportPath === 'string')) {
		throw new TypeError(`Unknown send provider '${kind}'`);
	}
	return transport as RuntimeTransport;
}
