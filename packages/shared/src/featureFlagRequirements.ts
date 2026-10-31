/**
 * What an enabled flag set needs from the host: docker compose profiles, env
 * vars, and a delivery provider for the sending flags.
 *
 * Import from `featureFlags.ts`, which re-exports everything here.
 */

import {
	coreSendProviderCatalogEntry,
	isCoreSendProviderKind,
	isOwnSendProviderKind,
	SEND_TRANSPORT_KINDS,
	type CoreSendProviderKind,
} from './sendProviderCatalog';
import { resolveFlags, type FeatureFlagKey, type FeatureFlagState } from './featureFlagRuntime';
import { FEATURE_FLAGS } from './featureFlagDefinitions';
import type { FeatureFlagResolutionOptions } from './featureFlagRegistry';

/**
 * Sending-category flags that can only function with a configured delivery
 * provider (`EMAIL_PROVIDER` + creds, or a `providerRoutes` row). These send
 * *bulk* mail through the provider abstraction — unlike `mail.external`, which
 * sends 1:1 personal replies through the user's OWN SMTP and is never a delivery
 * provider. `campaigns.archive` is excluded: it `requires:['campaigns']`, so it
 * can never be the lone reason a provider is needed.
 */
export const SENDING_FLAGS_REQUIRING_DELIVERY = [
	'campaigns',
	'transactional',
	'automations',
] as const satisfies readonly FeatureFlagKey[];

/**
 * Compute the docker compose profiles to activate for the given flag state.
 * Used by the setup CLI to generate `docker-compose.override.yml`.
 */
export function getActiveProfiles(
	stored: FeatureFlagState,
	opts: FeatureFlagResolutionOptions & { deliveryProvider?: string } = {}
): string[] {
	const resolved = resolveFlags(stored, opts);
	const profiles = new Set<string>();
	for (const def of Object.values(opts.registry ?? FEATURE_FLAGS)) {
		if (!resolved[def.key]) continue;
		for (const profile of def.dockerProfiles ?? []) profiles.add(profile);
	}
	// The built-in MTA is an opt-in service: it runs only when it is the delivery
	// provider, or when a receiving flag (postbox/inbox) needs it for inbound /
	// hosted send. The receiving cases add the 'mta' profile via their
	// dockerProfiles; the provider case is env-driven, so it is added here.
	//
	// TWO VOCABULARIES, one spelling. The question is the OWN-ARM one and is
	// asked through the catalog's declaration; the string added is a docker
	// COMPOSE PROFILE name, which belongs to compose and moves only when the
	// compose file does.
	if (isOwnSendProviderKind(opts.deliveryProvider)) profiles.add('mta');
	return Array.from(profiles).sort();
}

/**
 * Every compose profile the flag registry can ever produce — the profile
 * vocabulary the flag writers OWN.
 *
 * `getActiveProfiles` answers "which profiles do these flags want ON"; it does
 * NOT answer "which profiles should the host be running", because feature flags
 * are not the only thing that puts a profile in COMPOSE_PROFILES. The install
 * puts `tls` there for the Caddy edge and `dashboard` for the Convex dashboard,
 * and no flag can ever derive either. A writer that treats the derived set as
 * the whole truth therefore DELETES them — which, for `tls`, takes the
 * reverse proxy the operator is talking through offline.
 *
 * So the writers converge only this vocabulary and leave every other applied
 * profile alone (see `mergeComposeProfiles`).
 *
 * Plugin-contributed profiles belong to whichever registry the caller passes.
 * A caller that omits `registry` — the updater sidecar and the drift probe both
 * do, deliberately, so the two sides answer with the same vocabulary — treats a
 * plugin profile as install-owned and preserves it. Preserving a profile one
 * flag no longer wants is the recoverable direction; deleting one nothing can
 * re-derive is not.
 */
export function getFlagOwnedProfiles(opts: FeatureFlagResolutionOptions = {}): Set<string> {
	const owned = new Set<string>();
	for (const def of Object.values(opts.registry ?? FEATURE_FLAGS)) {
		for (const profile of def.dockerProfiles ?? []) owned.add(profile);
	}
	// The env-driven arm of `getActiveProfiles` — flag-derived in every sense
	// that matters here, since that function is the only thing that adds it.
	owned.add('mta');
	return owned;
}

/**
 * Compute the union of required env vars for the active flag set.
 * The CLI/wizard uses this to prompt only for env vars actually needed.
 */
export function getRequiredEnvVars(
	stored: FeatureFlagState,
	opts: FeatureFlagResolutionOptions & { deliveryProvider?: string } = {}
): string[] {
	const resolved = resolveFlags(stored, opts);
	const vars = new Set<string>();
	for (const def of Object.values(opts.registry ?? FEATURE_FLAGS)) {
		if (!resolved[def.key]) continue;
		for (const v of def.requiredEnvVars ?? []) vars.add(v);
	}
	// The bulk send path needs delivery-provider credentials that no single flag
	// can declare statically — the requirement is conditional on which provider
	// `EMAIL_PROVIDER` names. Fold them in when a sending feature is active and
	// the caller knows the provider, so the wizard/doctor model has no hole at
	// the core sending capability.
	if (opts.deliveryProvider && needsDeliveryProvider(stored, opts)) {
		for (const v of getSendPathRequiredEnv(opts.deliveryProvider)) vars.add(v);
	}
	return Array.from(vars).sort();
}

/**
 * True if the resolved flag set includes any sending-category flag that needs a
 * configured delivery provider. Pure and env-blind (it runs in the browser
 * wizard, where it cannot read `.env`): callers pair it with the backend
 * `isDeliveryConfigured` / `deliveryConfiguredFromEnv` to decide whether a
 * provider is actually present. This is the single predicate the wizard,
 * setup-cli, admin UI, and docs share for the "sending needs a provider" rule.
 */
export function needsDeliveryProvider(
	stored: FeatureFlagState,
	opts: FeatureFlagResolutionOptions = {}
): boolean {
	const resolved = resolveFlags(stored, opts);
	return SENDING_FLAGS_REQUIRING_DELIVERY.some((flag) => resolved[flag]);
}

/**
 * The delivery-provider kinds the bulk send path can route through, selected by
 * the `EMAIL_PROVIDER` env var.
 *
 * DERIVED from the send-provider catalog, not a local
 * list: this was the second of two declarations of the same union inside THIS
 * package, and the two did not import each other. `./sendProviderCatalog` is
 * data only, so the module stays browser-safe.
 *
 * The name survives the move because the setup surfaces read the union under it;
 * it is `SEND_TRANSPORT_KINDS` with another label, and the catalog suite pins
 * that they are the same list.
 */
export const DELIVERY_PROVIDER_KINDS = SEND_TRANSPORT_KINDS;
export type DeliveryProviderKind = CoreSendProviderKind;

/** True iff `value` names a known delivery provider (no implicit MTA default). */
export function isDeliveryProviderKind(value: string | undefined): value is DeliveryProviderKind {
	return isCoreSendProviderKind(value);
}

/**
 * Runtime env vars a given delivery provider needs before the send path can
 * actually deliver mail. This is the requirements model for the *core sending
 * capability*: the sending feature flags (campaigns/transactional/automations)
 * cannot declare it statically because the need is provider-conditional on
 * `EMAIL_PROVIDER`. The setup wizard prompts for these and `owlat doctor` fails
 * when a sending feature is enabled but they are absent.
 *
 * Mirrors the backend capability check (`providerKindConfigured` in
 * `apps/api/convex/lib/sendProviders/capability.ts`); `ses` additionally needs
 * `AWS_SES_REGION`, which the SES client construction requires. Unknown/unset
 * providers return `[]` — the "is a provider even selected?" question is
 * answered separately by `isDeliveryProviderKind`.
 */
export function getSendPathRequiredEnv(provider: string | undefined): string[] {
	// The catalog's `requiredEnvVars` IS this table — it was a per-kind switch
	// here, a per-kind list in the backend catalog and a third in
	// `./setupSendingPresets` until one derivation collapsed them. Which
	// variables are the presence gate (and why an optional refinement such as
	// `MANDRILL_WEBHOOK_KEY` is not one) is argued on the entries themselves.
	return [...(coreSendProviderCatalogEntry(provider)?.requiredEnvVars ?? [])];
}
