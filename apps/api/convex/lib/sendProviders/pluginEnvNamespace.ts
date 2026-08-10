/**
 * THE `PLUGIN_` FENCE, re-asserted about a generated ARTIFACT — one statement,
 * two load-time guards.
 *
 * Both hosted send-transport catalogs read the value of every configuration
 * variable their artifact declares and hand it to third-party code: the send half
 * (`./catalog.ts`, over `instanceEnvVars` + `credentialFields`) and the
 * sending-domain identity half
 * (`../../plugins/sendTransportDomainIdentityCatalog.ts`, over `instanceEnvVars`).
 * They were asserting the same rule with the same error text in two places, which
 * is the kind of duplication whose failure is silent: tightening the fence — say,
 * requiring the name to carry its owning plugin's id so plugin A cannot be handed
 * `PLUGIN_BETA_TOKEN` — in one copy leaves the other handing third-party code an
 * unrelated plugin's variable, with no test failing.
 *
 * ITS OWN FILE, AND A TRUE LEAF: only the kit. `./catalog.ts` is imported by
 * `./transports.ts`, so anything the catalog's module-scope validation depends on
 * has to sit below both of them — which is also why the config RESOLVER, which
 * needs the instance-suffix grammar from `./transports.ts`, is a separate file
 * (`./pluginTransportConfig.ts`) rather than a second export here.
 */

import { isPluginSendTransportEnvVar } from '@owlat/plugin-kit';

/**
 * Refuse a declared configuration variable outside the `PLUGIN_` namespace.
 *
 * THE NAMESPACE IS THE SECURITY FLOOR: an artifact naming `MTA_API_KEY` or
 * `AWS_SECRET_ACCESS_KEY` would hand a plugin this deployment's own credential.
 * The predicate is the kit's own, so the rule the manifest validator enforces at
 * authoring time and the rule the host re-asserts about the artifact — which is
 * what actually runs, and is exactly where a hand edit, a bad merge, a partial
 * regeneration or an older kit's validation lands — cannot drift apart.
 *
 * `subject` only spells the entry in the message ("Bundled plugin send transport",
 * "Bundled send transport domain identity"). The RULE is the same for both, which
 * is the point of there being one function.
 */
export function assertPluginTransportEnvVarNamespace(
	subject: string,
	kind: string,
	names: readonly string[]
): void {
	for (const name of names) {
		if (isPluginSendTransportEnvVar(name)) continue;
		throw new TypeError(
			`${subject} '${kind}' declares the configuration variable ` +
				`'${name}', which is outside the PLUGIN_ namespace a bundled transport may be ` +
				'handed the value of. See isPluginSendTransportEnvVar in ' +
				'packages/plugin-kit/src/sendTransport.ts.'
		);
	}
}
