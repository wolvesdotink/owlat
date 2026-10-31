/**
 * The names and environment constants a send-provider bundle is generated
 * around. The assembler (`scaffoldSendProvider`) imports the template modules
 * (`scaffoldSendProviderModules`, `scaffoldSendProviderStubs`) and all three need
 * these names, so they live in this leaf: a template module that took them from
 * the assembler would import it back.
 */

import { parsePluginLocalId, pluginNamespacedKind, type PluginId } from '@owlat/plugin-kit';
import { toCamelCase } from './names';

/**
 * The names a send-provider bundle is generated around, derived once from the
 * plugin id so no template string re-derives one.
 *
 * `screaming` is the environment-variable stem, and its shape is load-bearing:
 * `isPluginSendTransportEnvVar` refuses a `PLUGIN_`-less name, a name containing
 * the instance separator `__`, and a name ending in `_`. A plugin id is
 * `[a-z][a-z0-9]*(-[a-z0-9]+)*` — single hyphens, never leading or trailing — so
 * replacing each hyphen with one underscore can produce none of those, and the
 * emitted manifest is accepted for every id `create` accepts.
 */
export interface SendProviderNames {
	readonly id: PluginId;
	/** `acme-relay` ⇒ `ACME_RELAY`. */
	readonly screaming: string;
	/** `acme-relay` ⇒ `acmeRelay`. */
	readonly camel: string;
	/** `acme-relay` ⇒ `Acme Relay`, the operator-facing transport label. */
	readonly label: string;
	/** The transport's local id; the composed kind is `<this>`'s namespaced form. */
	readonly localId: string;
	/**
	 * The composed transport kind the emitted prose names, BUILT THROUGH THE
	 * GRAMMAR'S ONE BUILDER rather than spelled.
	 *
	 * `plugin.<pluginId>.<localId>` is a security boundary — core-vs-plugin
	 * dispatch and every ownership compare read it — so nothing outside
	 * `@owlat/plugin-kit` constructs one, and a generator that emitted a
	 * hand-spelled form into every scaffolded package would be the worst place to
	 * make an exception. `namespacedKindGrammar.test.ts` holds this file to it.
	 */
	readonly kind: string;
}

/** The local id every scaffolded bundle's single transport is given. */
export const SCAFFOLD_TRANSPORT_LOCAL_ID = 'relay';

/**
 * Every name a bundle is generated around, from the ONE input they all derive
 * from. The camel-case form is computed here rather than accepted as an argument:
 * a caller that passed a stale one would emit a manifest exporting `xPlugin` and
 * an `index.ts` re-exporting `yPlugin` — a package that does not compile, from a
 * generator whose determinism test still passes.
 */
export function sendProviderNames(id: PluginId): SendProviderNames {
	const camel = toCamelCase(id);
	return {
		id,
		screaming: id.replace(/-/g, '_').toUpperCase(),
		camel,
		label: id
			.split('-')
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(' '),
		localId: SCAFFOLD_TRANSPORT_LOCAL_ID,
		kind: pluginNamespacedKind(id, parsePluginLocalId(SCAFFOLD_TRANSPORT_LOCAL_ID)),
	};
}

/**
 * The bundle's environment variables, as the emitted `src/envNames.ts` declares
 * them.
 *
 * The two scopes are deliberately kept apart, and the manifest validator enforces
 * the separation both ways: `enabled` and `webhookSecret` are the PLUGIN's
 * deployment-wide gate (read unsuffixed, and the signing secret must be there or
 * the feedback route could be enabled with nothing to verify against), while
 * `apiKey` and `region` are the TRANSPORT's own configuration (resolved per
 * named instance under `__<INSTANCEKEY>`, and refused in the flag's list).
 */
export function sendProviderEnvVars(names: SendProviderNames): {
	readonly apiKey: string;
	readonly region: string;
	readonly webhookSecret: string;
	readonly enabled: string;
} {
	return {
		apiKey: `PLUGIN_${names.screaming}_API_KEY`,
		region: `PLUGIN_${names.screaming}_REGION`,
		webhookSecret: `PLUGIN_${names.screaming}_WEBHOOK_SECRET`,
		enabled: `${names.screaming}_ENABLED`,
	};
}

/**
 * The IDENTIFIERS the emitted `src/envNames.ts` binds those four names to, which
 * every other emitted file imports.
 *
 * ROLE, NOT VALUE — and the four are the same in every scaffolded package rather
 * than derived from the plugin id. A bundle holds exactly one provider, so
 * `API_KEY_ENV` is unambiguous inside it, and an identifier that grew with the id
 * would push the lines that mention it past the repository formatter's 100-column
 * width for every id longer than a short one. `create` scaffolds INTO this
 * workspace, where the first thing an author runs after it is `bun run lint`.
 */
export const SEND_PROVIDER_ENV_CONSTANTS = Object.freeze({
	apiKey: 'API_KEY_ENV',
	region: 'REGION_ENV',
	webhookSecret: 'WEBHOOK_SECRET_ENV',
	enabled: 'ENABLED_ENV',
} as const);
