import { isPluginSendTransportEnvVar, type PluginId } from '@owlat/plugin-kit';
import { isSendProviderKind, sendProviderCatalogEntry } from '../lib/sendProviders/catalog';
import { BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_CATALOG } from './sendTransportDomainIdentityCatalog.generated';
import { BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_MODULES } from './sendTransportDomainIdentityModules.generated';
import {
	defineHostedContributionCatalog,
	type HostedContributionDefinition,
} from './hostedContributionCatalog';

/**
 * Host view of a bundled send transport's SENDING-DOMAIN IDENTITY half (the
 * seams plan's D5, wired by P3.2) — the declaration side, plus the executable
 * provider-call half it is paired with.
 *
 * Two things live here because they are one fact with two representations, and
 * the value of the pair is that they are checked against each other at module
 * load: a catalog entry with no module registers a relay the host promises can
 * prove a domain and then cannot ask anything of, and a module with no catalog
 * entry is executable code no capability check governs. Both are refused before
 * the deployment serves a request, exactly as `sendTransportWebhookCatalog.ts`
 * does for the feedback half and `lib/sendProviders/index.ts` for the send half.
 *
 * ISOLATE-SAFE ON PURPOSE, and it is the constraint that shaped the piece.
 * `domains/providers/index.ts` composes its relay-identity registry from this
 * file, and that registry is read by the ENQUEUE transaction (`may this From
 * domain be handed to the configured relay?`). Nothing here — and nothing in the
 * generated module registry — may pull the Node runtime onto that path.
 */
export interface HostedSendTransportDomainIdentityDefinition extends HostedContributionDefinition<'send:transport'> {
	/** The contribution's local id; `kind` is this namespaced by the plugin id. */
	readonly localId: string;
	/** Operator-facing name, used as the reference arm's label. */
	readonly label: string;
	/**
	 * The transport's own configuration variables, required and optional together.
	 * The host resolves these per instance and hands the module exactly them.
	 */
	readonly instanceEnvVars: readonly string[];
	/** The subset without which the module cannot authenticate at all. */
	readonly requiredEnvVars: readonly string[];
}

/**
 * The executable half: two provider calls, both returning an outcome the host
 * decides the write rules for.
 *
 * Typed loosely here (`unknown` in, `unknown` out) for the same reason the
 * webhook module is: the module is third-party code reached through a generated
 * import, so its OUTPUT is untrusted input and is re-validated where it is
 * consumed rather than believed because a `satisfies` in a generated file said
 * so.
 */
export interface HostedSendTransportDomainIdentityModule {
	registerDomain(domain: string, config: unknown): Promise<unknown>;
	checkDomain(domain: string, config: unknown): Promise<unknown>;
}

/** One resolved identity surface: what it is, and what to ask it with. */
export interface HostedSendTransportDomainIdentity {
	readonly definition: HostedSendTransportDomainIdentityDefinition;
	readonly module: HostedSendTransportDomainIdentityModule;
}

const CATALOG = defineHostedContributionCatalog<HostedSendTransportDomainIdentityDefinition>(
	BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_CATALOG,
	'send transport domain identity'
);

interface GeneratedDomainIdentityModule {
	readonly kind: string;
	readonly pluginId: string;
	readonly module: unknown;
}

/**
 * Resolved surfaces keyed by the NAMESPACED TRANSPORT KIND — unlike the feedback
 * half, which is keyed by plugin id because its route surface is.
 *
 * An identity belongs to the transport whose account and credentials it was
 * registered under, and two transports of one plugin are two providers as far as
 * a sending domain is concerned. It is also the key the identity ROWS are written
 * under (`sendingDomainRelayIdentities.providerKind`), so a lookup by anything
 * else would be a second name for one thing.
 */
const BY_KIND = new Map<string, HostedSendTransportDomainIdentity>();

for (const generated of BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_MODULES as readonly GeneratedDomainIdentityModule[]) {
	const definition = CATALOG.byKind(generated.kind);
	if (!definition || definition.pluginId !== generated.pluginId || BY_KIND.has(generated.kind)) {
		throw new TypeError('Invalid bundled send transport domain identity registry');
	}
	// The identity half must belong to a transport the composed send catalog
	// actually holds, under the same owner. Otherwise a relay could prove domains
	// for a kind that never sends — a proof the routing gate would read while no
	// route could ever select the transport it names.
	if (!isSendProviderKind(definition.kind)) {
		throw new TypeError('Bundled send transport domain identity names an unknown transport kind');
	}
	if (sendProviderCatalogEntry(definition.kind).pluginId !== definition.pluginId) {
		throw new TypeError('Bundled send transport domain identity is not owned by its transport');
	}
	assertResolvableConfiguration(definition);
	BY_KIND.set(generated.kind, {
		definition,
		module: parseHostedDomainIdentityModule(generated.module),
	});
}
if (CATALOG.all.length !== BY_KIND.size) {
	throw new TypeError('Bundled send transport domain identity catalog is missing a module');
}

/**
 * The identity surface a transport kind addresses, or `undefined` when the kind
 * names no bundled identity.
 *
 * `undefined` is the fail-closed answer everywhere it is asked: the relay-proof
 * seam reports the domain unverifiable, the backfill provisions nothing, and the
 * alignment pre-flight holds the ramp at `unknown`. Lookup is by `Map`, so a
 * prototype key (`constructor`, `__proto__`) resolves to nothing rather than to
 * an inherited member being called as an adapter.
 */
export function pluginSendTransportDomainIdentityFor(
	kind: string
): HostedSendTransportDomainIdentity | undefined {
	return BY_KIND.get(kind);
}

/** Every registered identity kind, in catalog order. */
export function pluginSendTransportDomainIdentityKinds(): readonly string[] {
	return Object.freeze(CATALOG.all.map((entry) => entry.kind));
}

/**
 * The transport kind's definition, for the runtime-authorization seam: it
 * resolves a namespaced kind to its owning-plugin-tagged declaration exactly as
 * every other hosted bucket does.
 */
export function pluginSendTransportDomainIdentityDefinition(
	kind: string
): { readonly pluginId: PluginId } | undefined {
	return CATALOG.byKind(kind);
}

/**
 * Refuse an entry whose configuration this host could not resolve honestly.
 *
 * THE NAMESPACE IS THE SECURITY FLOOR, exactly as it is for the send half: the
 * host reads the value of every name in `instanceEnvVars` and hands it to
 * third-party code, so an artifact naming `MTA_API_KEY` or `AWS_SECRET_ACCESS_KEY`
 * would hand a plugin this deployment's own credential. The predicate is the
 * kit's own, so the rule the manifest validator enforces and the rule the host
 * re-asserts cannot drift apart.
 *
 * AN EMPTY REQUIRED LIST IS REFUSED for the reason manifest validation gives:
 * the module would be called with an empty environment and every provider call
 * it makes would be unauthenticated, which surfaces only as a relay reporting
 * every domain unverified forever. The manifest validator says so at authoring
 * time; this says it again about the ARTIFACT, which is what actually runs and
 * is exactly where a hand edit, a bad merge, a partial regeneration or an older
 * kit's validation lands.
 */
function assertResolvableConfiguration(
	definition: HostedSendTransportDomainIdentityDefinition
): void {
	if (definition.requiredEnvVars.length === 0) {
		throw new TypeError(
			`Bundled send transport domain identity '${definition.kind}' declares no required ` +
				'configuration variable, so its module would call the provider unauthenticated.'
		);
	}
	for (const name of definition.instanceEnvVars) {
		if (isPluginSendTransportEnvVar(name)) continue;
		throw new TypeError(
			`Bundled send transport domain identity '${definition.kind}' declares the configuration ` +
				`variable '${name}', which is outside the PLUGIN_ namespace a bundled transport may be ` +
				'handed the value of. See isPluginSendTransportEnvVar in ' +
				'packages/plugin-kit/src/sendTransport.ts.'
		);
	}
	for (const name of definition.requiredEnvVars) {
		if (definition.instanceEnvVars.includes(name)) continue;
		throw new TypeError(
			`Bundled send transport domain identity '${definition.kind}' requires the configuration ` +
				`variable '${name}' that it never resolves.`
		);
	}
}

/**
 * Accept only a plain object exposing exactly the two provider calls as data
 * properties.
 *
 * The same bar the other two halves set: a generated import that reached the
 * registry with a getter, a prototype, or a missing method is a failure that must
 * happen at module load — not one frame inside a scheduled identity call whose
 * only symptom is a domain that never verifies.
 */
function parseHostedDomainIdentityModule(input: unknown): HostedSendTransportDomainIdentityModule {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('Invalid bundled send transport domain identity module');
	}
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError('Invalid bundled send transport domain identity module');
	}
	const descriptors = Object.getOwnPropertyDescriptors(input);
	const keys = Reflect.ownKeys(descriptors);
	const registerDomain = descriptors['registerDomain'];
	const checkDomain = descriptors['checkDomain'];
	if (
		keys.length !== 2 ||
		!registerDomain?.enumerable ||
		!checkDomain?.enumerable ||
		!('value' in registerDomain) ||
		!('value' in checkDomain) ||
		typeof registerDomain.value !== 'function' ||
		typeof checkDomain.value !== 'function'
	) {
		throw new TypeError('Invalid bundled send transport domain identity module');
	}
	return Object.freeze({
		registerDomain: registerDomain.value as (domain: string, config: unknown) => Promise<unknown>,
		checkDomain: checkDomain.value as (domain: string, config: unknown) => Promise<unknown>,
	});
}
