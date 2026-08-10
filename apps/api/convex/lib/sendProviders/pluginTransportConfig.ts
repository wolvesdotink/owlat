/**
 * How the host turns a bundled transport's DECLARED configuration variables into
 * the `PluginSendTransportConfig` its module reads — once, for both tiers.
 *
 * The send half (`./pluginProvider.ts`, per routed transport instance) and the
 * sending-domain identity half (`../../domains/pluginRelay.ts`, always the
 * deployment-default instance) hand the SAME shape to the SAME third-party
 * module, so the two must resolve it identically. They had been written out twice,
 * and a divergence is quiet in a bad way: a refinement landing in one copy —
 * trimming, a redaction, a second presence rule — leaves the other handing modules
 * a differently-resolved environment, whose symptom is a relay reporting every
 * domain unverified with a provider 401 in a scheduled action log.
 *
 * Separate from `./pluginEnvNamespace.ts` because of what it depends on: this
 * needs `./transports.ts` for the instance-suffix grammar, and `./transports.ts`
 * imports `./catalog.ts`, whose own load-time guard asks for the namespace
 * assertion. Splitting the two keeps that guard on a leaf and the import graph
 * acyclic.
 */

import type { PluginSendTransportConfig } from '@owlat/plugin-kit';
import { getPluginTransportEnv } from '../env';
import { sendTransportEnvName } from './transports';

/**
 * This instance's configuration, or `null` when a required variable is absent.
 *
 * Keyed by the BASE name whatever the instance, so a module reads
 * `env['PLUGIN_ACME_TOKEN']` for every transport id it is sent through — the same
 * property `transportEnv.ts` gives a core adapter, which reads its typed `EnvKey`
 * and never spells the suffix either.
 *
 * `instanceKey: null` is the deployment-default instance, which reads the
 * unsuffixed variables. The sending-domain identity path is always that one: a
 * stored `deliverabilityFallback.relayProviderType` names a KIND, never a
 * `kind#instance` id, and an identity registered under one account is not a proof
 * about another.
 *
 * Only the names it is GIVEN are read. The caller passes the transport's own
 * declared variables; the contributing plugin's deployment-wide flag variables
 * are the plugin's, not this transport's to be handed. Every name has already
 * been fenced into the `PLUGIN_` namespace by the load-time guard that composed
 * the entry (`./pluginEnvNamespace.ts`).
 */
export function resolvePluginTransportConfig(
	instanceKey: string | null,
	instanceEnvVars: readonly string[],
	requiredEnvVars: readonly string[]
): PluginSendTransportConfig | null {
	const env: Record<string, string> = {};
	for (const name of instanceEnvVars) {
		const value = getPluginTransportEnv(sendTransportEnvName(name, instanceKey));
		if (value !== undefined) env[name] = value;
	}
	for (const name of requiredEnvVars) {
		if (env[name] === undefined) return null;
	}
	return Object.freeze({ instanceKey, env: Object.freeze(env) });
}
