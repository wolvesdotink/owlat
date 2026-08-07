/**
 * The `send-provider` scaffold template — the seams plan's P3.4.
 *
 * D4's policy is that provider N+1 is a PACKAGE, not a twelve-file hunt through
 * routing, dispatch, ramp and UI code. That policy only holds if the package is
 * cheap to start: a send-transport bundle has three executable halves, a
 * capability vocabulary, a credential form and a host-verified signature
 * contract, and an author assembling those from the reference documentation gets
 * a manifest that fails validation several times before it composes.
 *
 * So this template emits a bundle that is ALREADY COMPLETE and already correct:
 * every capability field this tier may declare is spelled (rather than defaulted,
 * so the author sees the vocabulary), every declared variable is joined to a
 * credential-form field, the webhook carries the replay provisions the host
 * requires, and the identity module is declared beside the required variable
 * without which it would call the provider unauthenticated. What is left for the
 * author is the VENDOR's half — the endpoints, the wire shapes, the selector —
 * and every one of those is marked `TODO` at the line it belongs on.
 *
 * WHY THE MODULES ARE `fetch`-SHAPED RATHER THAN `throw new Error('TODO')`. A
 * skeleton that throws is a skeleton nothing can run, so its first real exercise
 * is the author's first real deployment. These modules perform one HTTP call each
 * against a placeholder endpoint and map its outcome onto the kit's typed
 * vocabulary, which is the part of a provider integration that is the SAME for
 * every vendor and the part an author is most likely to get wrong (a 429 that
 * reads as a terminal failure retries nothing; a 500 that reads as terminal
 * drops a message a retry would have delivered). The emitted tests stub `fetch`
 * and pin exactly that mapping, and the conformance gate in
 * `examples/conformance` drives the whole emitted bundle through the shipped
 * routing, dispatch, feedback and identity modules unmodified.
 *
 * DETERMINISM. Every string below is a pure function of the plugin id and the
 * package name — no clock, no randomness — which is what
 * `__tests__/scaffoldSendProvider.test.ts` pins, for the reason the minimal
 * template's determinism is pinned: `create` refuses to clobber a file whose
 * content differs, so a generator that varied would make a re-run of `create`
 * fail against its own previous output.
 */

import { parsePluginLocalId, pluginNamespacedKind, type PluginId } from '@owlat/plugin-kit';
import type { PluginPackageName } from '@owlat/plugin-host';
import { toCamelCase } from './names';
import {
	domainIdentitySource,
	transportSource,
	webhookSource,
} from './scaffoldSendProviderModules';
import {
	domainIdentityTestSource,
	manifestTestSource,
	readmeSource,
	transportTestSource,
	webhookTestSource,
} from './scaffoldSendProviderStubs';

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
	/** `acme-relay` ⇒ `AcmeRelay`. */
	readonly pascal: string;
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
		pascal: camel.charAt(0).toUpperCase() + camel.slice(1),
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

/** The package export paths the manifest names, and the sources behind them. */
export const SEND_PROVIDER_MODULE_EXPORTS: Readonly<Record<string, string>> = Object.freeze({
	'./convex/transport': './src/convex/transport.ts',
	'./convex/webhook': './src/convex/webhook.ts',
	'./convex/domainIdentity': './src/convex/domainIdentity.ts',
});

/** Every file the send-provider template adds on top of the shared skeleton. */
export function sendProviderFiles(
	names: SendProviderNames,
	packageName: PluginPackageName
): ReadonlyMap<string, string> {
	const files = new Map<string, string>();
	files.set('src/envNames.ts', envNamesSource(names));
	files.set('src/manifest.ts', manifestSource(names));
	files.set('src/index.ts', indexSource(names));
	files.set('src/convex/transport.ts', transportSource(names));
	files.set('src/convex/webhook.ts', webhookSource(names));
	files.set('src/convex/domainIdentity.ts', domainIdentitySource(names));
	files.set('src/__tests__/manifest.test.ts', manifestTestSource(names));
	files.set('src/__tests__/transport.test.ts', transportTestSource(names));
	files.set('src/__tests__/webhook.test.ts', webhookTestSource(names));
	files.set('src/__tests__/domainIdentity.test.ts', domainIdentityTestSource(names));
	files.set('README.md', readmeSource(names, packageName));
	return files;
}

function envNamesSource(names: SendProviderNames): string {
	const env = sendProviderEnvVars(names);
	return `/**
 * ${names.id} — the bundle's ENVIRONMENT VARIABLE NAMES, declared once.
 *
 * A bundle spells each of these in at least two places: the MANIFEST declares it
 * (so the host resolves it, and so the credential form can write to it) and a
 * MODULE reads it out of the instance configuration it is handed. A string
 * literal on the module's side would go on being read after a rename, as a
 * credential the host never populates — an authentication failure rather than a
 * rename that did not compile.
 *
 * This module is therefore the single declaration, and the one thing in the
 * bundle every half may import: no \`@owlat/plugin-kit\` import, no Node builtin,
 * nothing with a runtime — so the isolate-safe halves (\`convex/webhook.ts\`,
 * \`convex/domainIdentity.ts\`) can read it without dragging anything into the
 * HTTP router's module graph.
 */

/** The transport's own credential — resolved per instance and handed to \`send\`. */
export const ${env.apiKey}_ENV = '${env.apiKey}';

/** An optional refinement: present only when this deployment set it. */
export const ${env.region}_ENV = '${env.region}';

/** The host-verified webhook signing secret. Plugin code never sees its value. */
export const ${env.webhookSecret}_ENV = '${env.webhookSecret}';

/** The plugin's deployment-wide enablement switch, distinct from the credential. */
export const ${env.enabled}_ENV = '${env.enabled}';
`;
}

/**
 * The four environment-name constants an emitted manifest imports, one per line
 * and SORTED BY THE NAME AS EMITTED.
 *
 * Sorted at generation time rather than written in a fixed order, because the
 * names are derived from the plugin id: the plugin-wide switch has no `PLUGIN_`
 * prefix, so whether it sorts before or after the transport's own variables
 * depends on the id. An unsorted import block is what a formatter or a reviewer
 * would fix by hand in every scaffolded package.
 */
function importedEnvNames(env: ReturnType<typeof sendProviderEnvVars>): string {
	return [env.apiKey, env.enabled, env.region, env.webhookSecret]
		.map((name) => `${name}_ENV`)
		.sort()
		.map((name) => `\t${name},`)
		.join('\n');
}

function manifestSource(names: SendProviderNames): string {
	const env = sendProviderEnvVars(names);
	return `/**
 * ${names.id} — the send-provider manifest: ONE data-only declaration naming
 * every capability this plugin may exercise and all three executable halves of
 * the bundle (send, feedback webhook, sending-domain identity).
 *
 * The host derives permissions, the composed catalog and the generated registries
 * from this data WITHOUT executing plugin code, so keep it static and data-only.
 *
 * TWO CAPABILITY WORDS ARE DERIVED RATHER THAN DECLARED, and there is deliberately
 * no field for either: \`hasProviderFeedback\` is true exactly when \`webhook\` is
 * present, and \`domainVerification\` is \`'api'\` exactly when \`domainIdentity\` is.
 * Delete a half and the promise the host reads disappears with it.
 */

import { definePlugin, PLUGIN_SEND_TRANSPORT_CAPABILITY } from '@owlat/plugin-kit';
import {
${importedEnvNames(env)}
} from './envNames';

/** The transport's local id; the composed kind is \`${names.kind}\`. */
export const ${names.screaming}_TRANSPORT_ID = '${names.localId}';

/** TODO: the headers your provider signs its webhook deliveries with. */
export const ${names.screaming}_SIGNATURE_HEADER = 'x-${names.id}-signature';
export const ${names.screaming}_TIMESTAMP_HEADER = 'x-${names.id}-timestamp';

/** The declared replay window, in seconds. The host clamps it again at ≤ 900. */
export const ${names.screaming}_TOLERANCE_SECONDS = 300;

export const ${names.camel}Plugin = definePlugin({
	id: '${names.id}',
	version: '0.0.0',
	capabilities: [PLUGIN_SEND_TRANSPORT_CAPABILITY],
	/**
	 * THE ENABLEMENT GATE, and it carries the WEBHOOK SECRET rather than the send
	 * credential. The two lists answer different questions: the transport's
	 * \`requiredEnvVars\` below is what one INSTANCE needs (and so what takes an
	 * \`__<INSTANCEKEY>\` suffix), while this is what the whole plugin needs before
	 * any of it counts as configured. The signing secret is deployment-wide —
	 * without it the feedback route can verify nothing and answers every delivery
	 * 503 — and it must NOT appear in the transport's list, which the host refuses.
	 */
	flag: {
		default: false,
		requiredEnvVars: [${env.enabled}_ENV, ${env.webhookSecret}_ENV],
	},
	contributes: {
		sendTransports: [
			{
				id: ${names.screaming}_TRANSPORT_ID,
				label: '${names.label}',
				module: { exportPath: './convex/transport' },
				/** Host-owned delays after a retryable failure; at most three. */
				retryDelays: [1_000, 5_000],
				requiredEnvVars: [${env.apiKey}_ENV],
				optionalEnvVars: [${env.region}_ENV],
				credentialFields: [
					{
						kind: 'secret',
						key: 'apiKey',
						label: 'API key',
						description: 'TODO: where an operator finds this in your provider console.',
						required: true,
						envVar: ${env.apiKey}_ENV,
					},
					{
						kind: 'select',
						key: 'region',
						label: 'Sending region',
						description: 'TODO: the regions your provider offers, or delete this field.',
						options: [
							{ value: 'eu', label: 'Europe' },
							{ value: 'us', label: 'United States' },
						],
						default: 'eu',
						envVar: ${env.region}_ENV,
					},
				],
				/**
				 * \`no\` is the ONLY value this tier may declare: the VERP local part a
				 * custom return path needs is signed with a deployment secret a bundled
				 * module is never handed. Spelled rather than omitted so the host
				 * re-reads it on the generated artifact.
				 */
				supportsCustomReturnPath: 'no',
				/** \`provider\` (your \`send\` returns the id) or \`composed\` (you echo ours). */
				messageIdSource: 'provider',
				/**
				 * Leave \`false\` unless your API really de-duplicates on an idempotency
				 * key AND this bundle carries that key into the request from
				 * \`buildSystemMailExtras\` — the host refuses a claim without the wiring,
				 * because a bare claim turns a double delivery into a "safe" retry.
				 */
				deduplicatesOnIdempotencyKey: false,
				webhook: {
					module: { exportPath: './convex/webhook' },
					/**
					 * THE HOST VERIFIES; the plugin only parses. Authenticity is never a
					 * plugin's decision, so this contract is what the host recomputes in
					 * constant time over \`<timestamp>.<rawBody>\` before your module runs.
					 * The \`replay\` provisions are REQUIRED: an HMAC over the body alone
					 * means a captured request verifies forever.
					 */
					signature: {
						header: ${names.screaming}_SIGNATURE_HEADER,
						algorithm: 'hmac-sha256',
						encoding: 'hex',
						secretEnvVar: ${env.webhookSecret}_ENV,
						replay: {
							timestampHeader: ${names.screaming}_TIMESTAMP_HEADER,
							toleranceSeconds: ${names.screaming}_TOLERANCE_SECONDS,
						},
					},
				},
				domainIdentity: { module: { exportPath: './convex/domainIdentity' } },
			},
		],
	},
});
`;
}

function indexSource(names: SendProviderNames): string {
	return `export { ${names.camel}Plugin } from './manifest';
`;
}
