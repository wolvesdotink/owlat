/**
 * THE SEND-PROVIDER CATALOG — one declaration, many derivations (the seams
 * plan's D1).
 *
 * What a provider IS, needs and can do, declared exactly once. Everything that
 * used to restate a piece of it now derives from here:
 *
 *   `SEND_TRANSPORT_KINDS`     the kind union itself, and with it
 *                              `CoreSendTransportKind` (`./transportAlignment`)
 *   `DELIVERY_PROVIDER_KINDS`  the same list, under the setup surfaces' name
 *   `getSendPathRequiredEnv`   `requiredEnvVars`, per kind (`./featureFlags`)
 *   `PROVIDER_ENV_KEYS`        every env variable the transport form owns
 *                              (`./setupSendingPresets`)
 *   `SMTP_RELAY_PRESETS`       one field's data, attached to that field
 *   the backend catalog        `apps/api/convex/lib/sendProviders/catalog.ts`
 *                              joins these entries to adapters and to the
 *                              bundled plugin tier, keeping its compile-time
 *                              completeness guards
 *
 * Before this file those were five independent declarations, two of them in
 * THIS package without importing each other, plus an if-chain in the setup
 * wizard that re-encoded the env mapping as imperative code. A sixth provider
 * had to be remembered in each.
 *
 * DATA ONLY — labels, typed field descriptors, env NAMES. Never env values,
 * never secrets, never adapter code: this module is in the web client bundle.
 *
 * THE CREDENTIAL FORM'S COPY IS MESSAGE KEYS, NOT SENTENCES. A
 * `credentialFields` entry's `label` and `description` (and the option labels
 * one of them attaches) are `sharedPkg.sendProviderCatalog.*` catalog keys: this
 * table is built at module scope, so it cannot call `t()`, and the only reader
 * of that copy is the web form (`TransportCredentialFields.vue`), which resolves
 * each one with `t()`. Nothing outside the browser prints them — the setup CLI
 * writes its own prompts, and an entry's own `label` (a vendor's NAME) stays
 * English on purpose, because the docs suite and the setup summary read it. A
 * bundled plugin's generated descriptors carry their own English label instead,
 * which the same `t()` passes through unchanged.
 *
 * The vocabulary it is written in lives in `./sendProviderCatalogTypes` and
 * `./sendProviderCredentialFields`, and the fail-closed default behind each
 * optional capability field lives in `./sendProviderCapabilities`. All three are
 * re-exported here so consumers import one module.
 *
 * Entry order is canonical: our MTA first, then relays in shipped order.
 */

import { deepFreeze } from './deepFreeze';
import { credentialFieldEnvVars, type CredentialFieldEnvVar } from './sendProviderCredentialFields';
import type {
	CoreSendProviderCatalogEntry,
	HostedSendTransportKind,
} from './sendProviderCatalogTypes';

export * from './sendProviderCapabilities';
export * from './sendProviderCatalogTypes';
export * from './sendProviderFeedback';
export * from './sendProviderCredentialFields';

import { CORE_SEND_PROVIDER_CATALOG } from './sendProviderCatalogData';

/**
 * The entries themselves, frozen THROUGH — see {@link deepFreeze}: the array,
 * each entry, its env-var and credential-field arrays, and the SMTP preset table
 * one of those fields carries.
 *
 * CORE, and the name says so: the backend composes bundled plugin entries onto
 * this list at load time and exports the union as `SEND_PROVIDER_CATALOG`. A
 * consumer in this package (or in web / setup-cli) has no plugin composition to
 * consult, so it must not be handed a name that implies it sees both tiers.
 */
export const CORE_SEND_PROVIDER_CATALOG_ENTRIES = deepFreeze(CORE_SEND_PROVIDER_CATALOG);

/**
 * A core send-transport kind — DERIVED from the catalog, per D1, so declaring an
 * entry widens the union and every consumer of it at once. This is the union
 * five separate literals used to spell.
 */
export type CoreSendProviderKind = (typeof CORE_SEND_PROVIDER_CATALOG)[number]['kind'];

/** A core kind or a bundled plugin's namespaced kind. */
export type SendTransportKind = CoreSendProviderKind | HostedSendTransportKind;

/**
 * The send-transport kinds Owlat supports, in catalog order. THE canonical list:
 * the backend's `SEND_PROVIDER_KINDS`, the setup surfaces'
 * `DELIVERY_PROVIDER_KINDS` and the outbound-alignment guard's
 * `CoreSendTransportKind` all read it, so a new provider kind cannot be added on
 * one side and silently drift past the others.
 */
export const SEND_TRANSPORT_KINDS: readonly CoreSendProviderKind[] = Object.freeze(
	CORE_SEND_PROVIDER_CATALOG.map((entry) => entry.kind)
);

const catalogByKind = new Map<string, (typeof CORE_SEND_PROVIDER_CATALOG)[number]>(
	CORE_SEND_PROVIDER_CATALOG.map((entry) => [entry.kind, entry])
);

if (catalogByKind.size !== CORE_SEND_PROVIDER_CATALOG.length) {
	throw new TypeError('Send provider kinds must be unique');
}

/** True iff `value` names a core send-provider kind. */
export function isCoreSendProviderKind(value: string | undefined): value is CoreSendProviderKind {
	return value !== undefined && catalogByKind.has(value);
}

/**
 * This kind's entry, or `undefined` for anything the catalog does not declare.
 *
 * Answers for CORE kinds only — bundled plugin entries are composed onto the
 * catalog by the backend at load time, so the backend's
 * `sendProviderCatalogEntry` is the lookup that sees both tiers. A caller in
 * this package (or in web/setup-cli) has no plugin composition to consult and
 * would get a wrong "unknown" rather than a right one; saying so in the name is
 * cheaper than the bug.
 */
export function coreSendProviderCatalogEntry(
	kind: string | undefined
): CoreSendProviderCatalogEntry | undefined {
	return kind === undefined ? undefined : catalogByKind.get(kind);
}

/** The entry declaring `tier: 'own'`, as a type. */
type OwnCatalogEntry = Extract<(typeof CORE_SEND_PROVIDER_CATALOG)[number], { tier: 'own' }>;

/**
 * THE OWN ARM's kind, at the TYPE level — the literal, derived.
 *
 * `Extract<…, { tier: 'own' }>['kind']` reads the same declaration
 * {@link OWN_SEND_PROVIDER_KIND} reads at runtime, so the compile-time guards
 * that need a literal (the backend's `OWN_ARM_TRANSPORT_KIND` and the
 * `_OwnInfrastructureKindsAgree` pin against the domain-provider registry's
 * `mtaProvider.kind`) can key off the catalog instead of off a second literal
 * somebody has to keep equal to it. Moving `tier: 'own'` to another entry moves
 * this type with it, and those guards then fail at BUILD time rather than
 * waiting for the runtime assertion in the backend's registry suite.
 *
 * Deliberately narrower than {@link CoreSendProviderKind}: a consumer that wants
 * "some send kind" wants that union; a consumer that wants "ours" wants this.
 */
export type OwnSendProviderKind = OwnCatalogEntry['kind'];

/**
 * THE OWN ARM, as a declaration — D3's "the own MTA is special by definition,
 * and by nothing else".
 *
 * Derived from `tier: 'own'` rather than written out, so the one identity
 * question that legitimately exists has exactly one answer in the repo. It used
 * to be `OWN_ARM_TRANSPORT_KIND` inside
 * `apps/api/convex/lib/sendProviders/strategies/adaptive_mix` — unreachable from
 * this package, from `apps/web` and from `apps/setup-cli`, all three of which
 * ask the same question, so all three restated it as `=== 'mta'`. It lives here
 * now because this is the leaf every one of them may import, and the backend
 * constant re-exports THIS rather than restating the literal.
 *
 * The catalog suite pins that exactly one entry carries `tier: 'own'`, which is
 * what makes the filter below total; the type is {@link OwnSendProviderKind},
 * derived from the same tier, so nothing downstream loses the literal by reading
 * the constant instead of writing the string.
 */
export const OWN_SEND_PROVIDER_KIND: OwnSendProviderKind = (() => {
	const own = CORE_SEND_PROVIDER_CATALOG.filter(
		(entry): entry is OwnCatalogEntry => entry.tier === 'own'
	);
	if (own.length !== 1) {
		throw new TypeError('Exactly one send provider entry may declare tier: own');
	}
	return own[0]!.kind;
})();

/**
 * Is this the OWN arm — our own MTA — rather than a relay?
 *
 * The one capability-shaped reading of a kind's identity, per D3: the own MTA is
 * the arm a deliverability fallback moves traffic AWAY from, so "ours vs. not
 * ours" is a real question rather than a vendor special case. Ask it here
 * instead of comparing to a literal, so the answer moves with the catalog.
 *
 * Takes `string | undefined` because most callers hold an env value or a stored
 * provider name: an unset or unknown provider is not the own arm, which is both
 * the true and the fail-closed answer.
 */
export function isOwnSendProviderKind(kind: string | undefined | null): boolean {
	return kind != null && kind === OWN_SEND_PROVIDER_KIND;
}

/** Every credential field declared by any core kind, as a type. */
type CoreCredentialField = (typeof CORE_SEND_PROVIDER_CATALOG)[number]['credentialFields'][number];

/**
 * Every env variable the transport FORM owns, across all kinds — the derivation
 * `PROVIDER_ENV_KEYS` (`./setupSendingPresets`) is built from.
 *
 * The FORM, not the kind: a variable an installer writes (`MTA_API_URL`) is
 * required to send but is not a field, and must stay out of a list that is
 * cleared and re-set on every transport swap. The entries say which is which by
 * declaring one and not the other.
 */
export type TransportCredentialEnvKey = CredentialFieldEnvVar<CoreCredentialField>;

/** {@link TransportCredentialEnvKey}, at runtime, in catalog × field order. */
export const TRANSPORT_CREDENTIAL_ENV_KEYS: readonly TransportCredentialEnvKey[] = Object.freeze(
	CORE_SEND_PROVIDER_CATALOG.flatMap((entry) =>
		entry.credentialFields.flatMap((field) => credentialFieldEnvVars(field))
	)
);
