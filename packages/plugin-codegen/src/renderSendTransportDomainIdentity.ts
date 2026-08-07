import { parsePluginPackageName, type BundledPlugin } from '@owlat/plugin-host';
import { parsePluginId, pluginNamespacedKind } from '@owlat/plugin-kit';
import {
	GENERATED_HEADER,
	renderPluginModuleFile,
	type PluginModuleFileEntry,
} from './renderShared';

/**
 * The SENDING-DOMAIN IDENTITY half of a bundled send transport (the seams plan's
 * D5, wired by P3.2) — its own module for the same reason the feedback half, the
 * crons and the automation registries have theirs: `render.ts` is the
 * composition, not the renderer of every artifact.
 */

interface RenderedSendTransportDomainIdentity extends PluginModuleFileEntry {
	readonly localId: string;
	readonly label: string;
	/**
	 * The transport's own configuration variables, required and optional together
	 * — the ones the host resolves per instance and hands to the identity module.
	 *
	 * CARRIED HERE RATHER THAN READ OFF THE SEND CATALOG, even though it is the
	 * same list, because the two artifacts are loaded by different code in
	 * different runtimes: this registry is composed into `domains/providers/`,
	 * which the enqueue path reads, and having it reach across to the send
	 * catalog's entry would put the whole send-tier composition — including its
	 * `'use node'`-adjacent guards — on that path to answer one question about
	 * variable names.
	 */
	readonly instanceEnvVars: readonly string[];
	readonly requiredEnvVars: readonly string[];
}

/**
 * Every bundled transport that declares a sending-domain identity.
 *
 * Keyed by the same namespaced kind as the send half — which is what makes the
 * identity rows land in `sendingDomainRelayIdentities` under
 * `providerKind: 'plugin.<id>.<local>'` (D10: rows, not columns; the field is a
 * plain string and no schema changed for this).
 *
 * THE CONFIGURATION IT CARRIES IS THE TRANSPORT'S OWN, never the plugin's
 * deployment-wide flag variables, and the derivation is deliberately the same
 * one `renderSendTransport.ts` makes for `instanceEnvVars`: a flag variable
 * gates whether the PLUGIN may run and is read unsuffixed by the authorization
 * path, while only an instance-scoped variable gets a `__<INSTANCEKEY>` copy.
 * Manifest validation already refuses an identity on a transport with no
 * required variable of its own, so a manifest this codegen sees has one — but
 * the artifact is what runs, and an entry whose required list rendered empty
 * would have the host call the provider with an empty environment.
 */
function domainIdentitiesFor(
	plugins: readonly BundledPlugin[]
): readonly RenderedSendTransportDomainIdentity[] {
	return plugins.flatMap((plugin) =>
		(plugin.manifest.contributes?.sendTransports ?? []).flatMap((transport) => {
			if (!transport.domainIdentity) return [];
			const flagEnvVars = plugin.manifest.flag?.requiredEnvVars ?? [];
			const isOwnEnvVar = (name: string): boolean => !flagEnvVars.includes(name);
			const requiredEnvVars = (transport.requiredEnvVars ?? []).filter(isOwnEnvVar);
			const optionalEnvVars =
				requiredEnvVars.length > 0 ? (transport.optionalEnvVars ?? []).filter(isOwnEnvVar) : [];
			return [
				{
					packageName: parsePluginPackageName(plugin.packageName),
					pluginId: parsePluginId(plugin.manifest.id),
					localId: transport.id,
					kind: pluginNamespacedKind(plugin.manifest.id, transport.id),
					label: transport.label,
					exportPath: transport.domainIdentity.module.exportPath,
					instanceEnvVars: [...requiredEnvVars, ...optionalEnvVars],
					requiredEnvVars,
				},
			];
		})
	);
}

export function renderSendTransportDomainIdentityCatalog(
	plugins: readonly BundledPlugin[]
): string {
	const entries = domainIdentitiesFor(plugins)
		.map(
			(identity) => `\tObject.freeze({
\t\tkind: ${JSON.stringify(identity.kind)},
\t\tpluginId: ${JSON.stringify(identity.pluginId)},
\t\tlocalId: ${JSON.stringify(identity.localId)},
\t\tlabel: ${JSON.stringify(identity.label)},
\t\tinstanceEnvVars: Object.freeze(${JSON.stringify(identity.instanceEnvVars)}),
\t\trequiredEnvVars: Object.freeze(${JSON.stringify(identity.requiredEnvVars)}),
\t\trequiredCapability: 'send:transport',
\t}),`
		)
		.join('\n');
	const catalog = entries
		? `Object.freeze([\n${entries}\n] as const)`
		: 'Object.freeze([] as const)';
	return `${GENERATED_HEADER}export const BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_CATALOG = ${catalog};\n`;
}

export function renderSendTransportDomainIdentityModules(
	plugins: readonly BundledPlugin[]
): string {
	// NOT `'use node'`, and unlike the send half that is a hard requirement rather
	// than a preference: this registry is composed into `domains/providers/`, which
	// the ENQUEUE transaction reads to answer "may this domain be relayed?". A
	// `'use node'` import there would put the hottest read path we have into the
	// Node runtime. The two calls an identity module makes are HTTP, and `fetch` is
	// available in both runtimes — nothing invokes them from a transaction, which
	// Convex forbids outright.
	return renderPluginModuleFile(domainIdentitiesFor(plugins), {
		varPrefix: 'bundledPluginSendTransportDomainIdentity',
		contract: 'PluginSendTransportDomainIdentityModule',
		modulesConst: 'BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_MODULES',
		useNode: false,
	});
}
