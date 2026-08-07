import { parsePluginPackageName, type BundledPlugin } from '@owlat/plugin-host';
import {
	parsePluginId,
	pluginNamespacedKind,
	type PluginSendTransportCredentialField,
} from '@owlat/plugin-kit';
import { GENERATED_HEADER } from './renderShared';

/**
 * The SEND half of a bundled send transport — the isolate-safe metadata catalog
 * and the `'use node'` executable registry.
 *
 * Its own module for the same reason its feedback half, the crons and the
 * automation registries have theirs: `render.ts` is the composition, not the
 * renderer of every artifact. It grew one when contract parity (the seams plan's
 * P3.1) gave the catalog entry a capability vocabulary, a configuration and a
 * credential form to carry.
 */

interface RenderedSendTransport {
	readonly packageName: string;
	readonly pluginId: string;
	readonly localId: string;
	readonly kind: string;
	readonly label: string;
	readonly exportPath: string;
	readonly retryDelays: readonly number[];
	readonly requiredEnvVars: readonly string[];
	readonly optionalEnvVars: readonly string[];
	/**
	 * The transport's OWN variables, required and optional together — the ones the
	 * host resolves PER INSTANCE and hands to the module. Empty for a transport
	 * that declares none, which is what tells the transport resolver that this kind
	 * cannot have named instances.
	 */
	readonly instanceEnvVars: readonly string[];
	readonly supportsCustomReturnPath: string | undefined;
	readonly messageIdSource: string | undefined;
	readonly deduplicatesOnIdempotencyKey: boolean;
	readonly hasProviderFeedback: boolean;
	readonly credentialFields: readonly PluginSendTransportCredentialField[];
}

/**
 * THE PRESENCE GATE OF A BUNDLED TRANSPORT (the seams plan's P3.1).
 *
 * IT IS THE UNION, and it has to be. `providerKindConfigured` is exactly
 * `requiredEnvVars.every(isEnvPresent)`, and it feeds `configuredSendProviderKinds`
 * — the env-only readiness the campaign cell seam records an assignment row
 * against. A transport whose own `PLUGIN_ACME_TOKEN` is set inside a plugin whose
 * `ACME_PACK_ENABLED` never was is not configured in any sense an operator would
 * recognise: the authoritative dispatch path refuses it on the flag, permanently,
 * so gating on the transport's own list alone would produce a mis-assignment that
 * never resolves rather than the transient staleness that seam documents.
 *
 * A transport that declares NO configuration of its own therefore keeps exactly
 * the shipped rule (the union is just the plugin's `flag.requiredEnvVars`) and a
 * manifest written against the older contract composes byte-identically.
 *
 * THE TWO HALVES STAY DISTINGUISHABLE, which is what `instanceEnvVars` is for. A
 * flag variable gates whether the PLUGIN may run at all and is checked unsuffixed
 * by the host's authorization path; only an instance-scoped variable gets a
 * `__<INSTANCEKEY>` copy, and `transports.ts` suffixes exactly the names that
 * appear in `instanceEnvVars` for that reason. The host hands a module the
 * intersection, never the flag variables — those are the plugin's, not this
 * transport's.
 *
 * WHETHER A KIND IS INSTANCE-SCOPED IS DECIDED ON THE REQUIRED LIST ALONE, not on
 * "declared anything". An optional-only declaration is refused at manifest
 * validation, so a manifest this codegen ever sees has both or neither — but the
 * artifact is what runs, and an entry whose `requiredEnvVars` rendered as `[]`
 * would be reported CONFIGURED by `providerKindConfigured` (every member of an
 * empty list is present). For the same reason such an entry gets no
 * `instanceEnvVars`: a kind whose requirement list is empty cannot answer whether
 * a named instance is configured, so `instances_unsupported` is the honest
 * refusal.
 */
function sendTransportsFor(plugins: readonly BundledPlugin[]): readonly RenderedSendTransport[] {
	return plugins.flatMap((plugin) =>
		(plugin.manifest.contributes?.sendTransports ?? []).map((transport) => {
			const declaredRequired = transport.requiredEnvVars ?? [];
			const isInstanceScoped = declaredRequired.length > 0;
			const declaredOptional = isInstanceScoped ? (transport.optionalEnvVars ?? []) : [];
			const instanceEnvVars = isInstanceScoped ? [...declaredRequired, ...declaredOptional] : [];
			const flagEnvVars = plugin.manifest.flag?.requiredEnvVars ?? [];
			return {
				packageName: parsePluginPackageName(plugin.packageName),
				pluginId: parsePluginId(plugin.manifest.id),
				localId: transport.id,
				kind: pluginNamespacedKind(plugin.manifest.id, transport.id),
				label: transport.label,
				exportPath: transport.module.exportPath,
				retryDelays: transport.retryDelays,
				// Flag variables FIRST and deduplicated: the order is what a setup
				// surface lists, and "enable the plugin, then give the transport its
				// credential" is the order an operator does it in.
				requiredEnvVars: [
					...flagEnvVars,
					...declaredRequired.filter((name) => !flagEnvVars.includes(name)),
				],
				optionalEnvVars: declaredOptional,
				instanceEnvVars,
				// The FORM, carried through untouched: every descriptor's `envVar` was
				// joined to one of the two lists above at manifest validation, so it
				// names a variable this entry also declares.
				credentialFields: isInstanceScoped ? (transport.credentialFields ?? []) : [],
				supportsCustomReturnPath: transport.supportsCustomReturnPath,
				messageIdSource: transport.messageIdSource,
				deduplicatesOnIdempotencyKey: transport.deduplicatesOnIdempotencyKey === true,
				// DERIVED, never declared: a transport reports feedback exactly when it
				// contributes a webhook to parse it with. Two fields could disagree; one
				// fact stated once cannot. The catalog's `providerFeedback` DESCRIPTOR
				// is deliberately not emitted alongside it — it tells the delivery page
				// which console ceremony to draw, and this tier's route is one generic
				// `/webhooks/plugin/<pluginId>` surface with no per-kind panel.
				hasProviderFeedback: transport.webhook !== undefined,
			};
		})
	);
}

/** A frozen array literal, or `undefined` for an empty list (the field is dropped). */
function frozenArrayLiteral(values: readonly unknown[]): string | undefined {
	return values.length > 0 ? `Object.freeze(${JSON.stringify(values)})` : undefined;
}

/** A JSON literal, or `undefined` for a value the manifest did not declare. */
function jsonLiteral(value: string | undefined): string | undefined {
	return value === undefined ? undefined : JSON.stringify(value);
}

/** A boolean field emitted only when TRUE — absent is the fail-closed default. */
function trueLiteral(value: boolean): string | undefined {
	return value ? 'true' : undefined;
}

/**
 * ONE CATALOG ENTRY, as `[field, literal]` pairs.
 *
 * A list rather than one interpolated template because the ORDER is asserted by
 * `__tests__/sendTransportCapabilities.test.ts` (a generated file that reshuffles
 * itself is a diff nobody can review), and an ordering rule is only checkable
 * against something that can be read as a sequence. A pair whose literal is
 * `undefined` is dropped: the catalog's defaults are the fail-closed ones, so an
 * absent field and a field set to its default mean the same thing and the shorter
 * artifact is the one an operator can read.
 */
function sendTransportCatalogFields(
	transport: RenderedSendTransport
): readonly (readonly [string, string | undefined])[] {
	return [
		['kind', JSON.stringify(transport.kind)],
		['pluginId', JSON.stringify(transport.pluginId)],
		['localId', JSON.stringify(transport.localId)],
		['label', JSON.stringify(transport.label)],
		['retryDelays', `Object.freeze(${JSON.stringify(transport.retryDelays)})`],
		// ALWAYS EMITTED, empty or not: it is the presence gate, and the catalog
		// shape declares it non-optional.
		['requiredEnvVars', `Object.freeze(${JSON.stringify(transport.requiredEnvVars)})`],
		['optionalEnvVars', frozenArrayLiteral(transport.optionalEnvVars)],
		['instanceEnvVars', frozenArrayLiteral(transport.instanceEnvVars)],
		['credentialFields', frozenArrayLiteral(transport.credentialFields)],
		['supportsCustomReturnPath', jsonLiteral(transport.supportsCustomReturnPath)],
		['messageIdSource', jsonLiteral(transport.messageIdSource)],
		['deduplicatesOnIdempotencyKey', trueLiteral(transport.deduplicatesOnIdempotencyKey)],
		['hasProviderFeedback', trueLiteral(transport.hasProviderFeedback)],
		['requiredCapability', "'send:transport'"],
	];
}

export function renderSendTransportCatalog(plugins: readonly BundledPlugin[]): string {
	const entries = sendTransportsFor(plugins)
		.map((transport) => {
			const fields = sendTransportCatalogFields(transport)
				.filter((pair): pair is readonly [string, string] => pair[1] !== undefined)
				.map(([name, literal]) => `\t\t${name}: ${literal},`)
				.join('\n');
			return `\tObject.freeze({\n${fields}\n\t}),`;
		})
		.join('\n');
	const catalog = entries ? `Object.freeze([\n${entries}\n])` : 'Object.freeze([])';
	return `${GENERATED_HEADER}export const BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG = ${catalog};\n`;
}

export function renderSendTransportModules(plugins: readonly BundledPlugin[]): string {
	const transports = sendTransportsFor(plugins);
	const imports = transports
		.map(
			(transport, index) =>
				`import bundledPluginSendTransport${index} from ${JSON.stringify(`${transport.packageName}${transport.exportPath.slice(1)}`)};`
		)
		.join('\n');
	const entries = transports
		.map(
			(transport, index) =>
				`\tObject.freeze({ kind: ${JSON.stringify(transport.kind)}, pluginId: ${JSON.stringify(transport.pluginId)}, module: bundledPluginSendTransport${index} }),`
		)
		.join('\n');
	const modules = entries ? `Object.freeze([\n${entries}\n])` : 'Object.freeze([])';
	return `'use node';\n\n${GENERATED_HEADER}${imports}${imports ? '\n\n' : ''}export const BUNDLED_PLUGIN_SEND_TRANSPORT_MODULES = ${modules};\n`;
}
