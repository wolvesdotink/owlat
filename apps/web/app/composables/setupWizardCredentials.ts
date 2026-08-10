/**
 * THE TRANSPORT CREDENTIAL FORM, DERIVED — the seams plan's D5 ("a provider is a
 * bundle; UI renders descriptors, it doesn't know providers").
 *
 * Every surface that collects sending credentials — the in-app transport editor,
 * the connect-a-provider wizard's first step — used to carry one hand-written
 * block per vendor, and `buildProviderEnv` re-encoded the same per-provider env
 * mapping a third time as an if-chain. All three are now ONE loop over the
 * catalog entry's `credentialFields` (`@owlat/shared/sendProviderCatalog`), and
 * this module is where a descriptor becomes form state and env lines.
 *
 * WHAT LIVES HERE, and nothing else:
 *
 *   {@link seedCredentialValues}   the blank form, with each descriptor's
 *                                  declared default already in it
 *   {@link credentialEnvVarFor}    one field KEY → the variable it writes, for a
 *                                  surface that seeds one field itself
 *   {@link credentialFieldEnv}     one descriptor → the env variables it owns
 *   {@link transportCredentialEnv} one KIND → the env patch its form writes
 *   {@link credentialValuesFromDraft} / {@link draftCredentialsFromValues}
 *                                  the two directions of the LEGACY bridge
 *
 * VALUES ARE KEYED BY ENV VARIABLE NAME, not by field key. A descriptor's whole
 * purpose is to name the deployment variable it writes, the env patch is what
 * leaves the browser, and `PROVIDER_ENV_KEYS` (the server's allowlist) is a list
 * of those same names — so keying the form by anything else would mean a
 * translation step at every boundary. Field keys are unique per provider, not
 * across providers; env names are unique across the catalog, which is what lets
 * one flat map hold the whole form.
 *
 * THE LEGACY BRIDGE, and the piece that deletes it. `EmailStepDraft` still spells
 * its credential half per vendor (`resendKey`, `ses.region`, `smtp.host`, …)
 * because the SETUP wizard's own pages and its validation rules — the surfaces
 * the seams plan leaves to the descriptor follow-up outside `apps/web/app/**` —
 * are written against that shape and pin it in their suites. So the two
 * functions at the bottom project between the draft and the env-keyed values,
 * in both directions, in ONE place instead of at each call site. Both are
 * exhaustive over `TransportCredentialEnvKey` at COMPILE time: a provider whose
 * credentials the draft cannot carry fails the build here rather than silently
 * writing nothing. When the wizard's draft becomes the values map itself, both
 * functions and this paragraph go with it.
 */

import {
	type SendProviderCredentialField,
	type SendProviderHostPortField,
	type SmtpRelayPreset,
	type TransportCredentialEnvKey,
} from '@owlat/shared/sendProviderCatalog';
import type { OutboundTlsMode } from '@owlat/shared/outboundTlsMode';
import { composedSendProviderCatalogEntry } from '~/utils/composedSendProviderCatalog';
import type { EmailStepDraft } from './useSetupWizard';

/**
 * The form's state: every credential value the operator has entered, keyed by
 * the deployment variable it will be written to. Strings throughout — a form
 * field holds text, and the descriptor says how to read it back (`'true'` /
 * `'false'` for a boolean, a decimal string for a port).
 */
export type TransportCredentialValues = Record<string, string>;

/** The credential fields a kind declares, or none for a kind we do not know. */
export function credentialFieldsFor(
	kind: string | null | undefined
): readonly SendProviderCredentialField[] {
	return composedSendProviderCatalogEntry(kind ?? undefined)?.credentialFields ?? [];
}

/** The first missing required credential, phrased for a generic form. */
export function requiredCredentialError(
	kind: string | null | undefined,
	values: TransportCredentialValues
): string | undefined {
	for (const field of credentialFieldsFor(kind)) {
		if (field.required === true && (values[field.envVar] ?? '').trim() === '') {
			return `Enter ${field.label.toLowerCase()}.`;
		}
	}
	return undefined;
}

/**
 * The endpoint descriptor a kind declares, if it has one — the composite that
 * carries a relay's host, port and implicit-TLS flag together, and the preset
 * table that prefills all three.
 */
export function hostPortFieldFor(
	kind: string | null | undefined
): SendProviderHostPortField | undefined {
	return credentialFieldsFor(kind).find(
		(field): field is SendProviderHostPortField => field.kind === 'host-port'
	);
}

/**
 * The env variable ONE named field of a kind writes, or `undefined` when that
 * kind declares no such field.
 *
 * For the surface that has to SEED one field from a value of its own (the
 * transport editor seeds the outbound-TLS floor from the active mode, so
 * re-applying an edit cannot silently reset it). Spelling the variable name
 * there instead would be a second declaration with no link to the descriptor:
 * `TransportCredentialValues` is keyed by `string`, so a rename in the catalog
 * would leave that write landing on a dead key, the control falling back to its
 * default, and every apply quietly lowering the operator's chosen floor — with a
 * green build.
 */
export function credentialEnvVarFor(
	kind: string | null | undefined,
	fieldKey: string
): string | undefined {
	return credentialFieldsFor(kind).find((field) => field.key === fieldKey)?.envVar;
}

/** Read a form checkbox back out of its string value. */
export function readBooleanValue(raw: string | undefined, fallback: boolean): boolean {
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	return fallback;
}

/**
 * The blank form for a kind: every declared default already filled in, so the
 * fields the operator never touches still write what the descriptor promised.
 *
 * A `host-port` endpoint is seeded from its FIRST preset rather than from its
 * bare defaults, which is what the shipped forms have always shown (a Mailgun
 * host on 587, editable). The first entry is the preset table's own order, so a
 * provider that reorders its presets moves this seed with it.
 */
export function seedCredentialValues(kind: string | null | undefined): TransportCredentialValues {
	const values: TransportCredentialValues = {};
	for (const field of credentialFieldsFor(kind)) {
		if (field.kind === 'host-port') {
			const preset = firstPreset(field);
			values[field.envVar] = preset?.config.host ?? '';
			values[field.portEnvVar] = preset?.config.port ?? field.portDefault;
			values[field.secureEnvVar] = String(preset?.config.secure ?? field.secureDefault);
			continue;
		}
		if (field.kind === 'boolean') {
			values[field.envVar] = String(field.default ?? false);
			continue;
		}
		if (field.kind === 'number') {
			values[field.envVar] = field.default === undefined ? '' : String(field.default);
			continue;
		}
		values[field.envVar] = 'default' in field ? (field.default ?? '') : '';
	}
	return values;
}

/** The first preset a `host-port` field offers, in the table's declared order. */
export function firstPreset(
	field: SendProviderHostPortField
): { key: SmtpRelayPreset; config: { host: string; port: string; secure: boolean } } | undefined {
	const entries = Object.entries(field.presets ?? {});
	const first = entries[0];
	return first === undefined ? undefined : { key: first[0] as SmtpRelayPreset, config: first[1] };
}

/**
 * ONE DESCRIPTOR → the env lines it owns.
 *
 * The normalisation rules are the FIELD KIND's, not the provider's, and each one
 * reproduces exactly what the per-vendor if-chain did before it:
 *
 *  - `host-port` trims the host, falls back to the declared `portDefault` when
 *    the port is left blank (so a stale on-disk value can never survive a merge)
 *    and writes the TLS flag as an explicit `'true'` / `'false'`.
 *  - `select` falls back to its declared default when unset, which is how the
 *    own MTA's outbound-TLS floor has always been written explicitly rather than
 *    left to the backend's default.
 *  - `boolean` writes `'true'` / `'false'`.
 *  - everything else writes what was typed, verbatim. A region or an API key is
 *    free text: normalising it here would silently change a credential.
 *
 * EXPORTED FOR ITS SUITE, which is a real consumer and the only possible one for
 * the `boolean` rule: no shipped entry declares a boolean credential, so that
 * branch cannot be reached through {@link transportCredentialEnv} and would ship
 * unproven until provider N+1 met it. (Nuxt auto-imports every exported name in
 * this directory into every component namespace, so an export here has to earn
 * itself — see the collision note on `~/utils/transportState`.)
 */
export function credentialFieldEnv(
	field: SendProviderCredentialField,
	values: TransportCredentialValues
): Record<string, string> {
	if (field.kind === 'host-port') {
		const port = (values[field.portEnvVar] ?? '').trim();
		return {
			[field.envVar]: (values[field.envVar] ?? '').trim(),
			[field.portEnvVar]: port || field.portDefault,
			[field.secureEnvVar]: String(
				readBooleanValue(values[field.secureEnvVar], field.secureDefault)
			),
		};
	}
	if (field.kind === 'select') {
		return { [field.envVar]: values[field.envVar] || (field.default ?? '') };
	}
	if (field.kind === 'boolean') {
		return {
			[field.envVar]: String(readBooleanValue(values[field.envVar], field.default ?? false)),
		};
	}
	return { [field.envVar]: values[field.envVar] ?? '' };
}

/**
 * ONE KIND → the credential half of its env patch, in catalog × field order.
 *
 * A kind this build does not know writes nothing, which is the fail-closed
 * answer: the apply endpoint allowlists what it accepts, and inventing keys for
 * an unknown transport would be the one way to get past it.
 */
export function transportCredentialEnv(
	kind: string | null | undefined,
	values: TransportCredentialValues
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const field of credentialFieldsFor(kind)) {
		Object.assign(env, credentialFieldEnv(field, values));
	}
	return env;
}

/** Every value the operator has entered into a `secret` field, across all kinds. */
export function secretEnvKeys(kinds: readonly string[]): readonly string[] {
	return kinds.flatMap((kind) =>
		credentialFieldsFor(kind)
			.filter((field) => field.kind === 'secret')
			.map((field) => field.envVar)
	);
}

// ── The legacy bridge (see the module docblock) ──────────────────────────────

/** The credential half of {@link EmailStepDraft}, as the wizard still spells it. */
export type DraftCredentials = Pick<
	EmailStepDraft,
	'resendKey' | 'emailitKey' | 'mandrillKey' | 'ses' | 'smtp' | 'outboundTlsMode'
>;

/**
 * Draft → values. Exhaustive over `TransportCredentialEnvKey`, so a catalog
 * entry whose credential fields the draft has no home for is a BUILD failure in
 * this one file rather than a form that silently writes nothing.
 */
export function credentialValuesFromDraft(
	draft: EmailStepDraft
): Record<TransportCredentialEnvKey, string> {
	return {
		OUTBOUND_TLS_MODE: draft.outboundTlsMode ?? '',
		AWS_SES_REGION: draft.ses.region,
		AWS_SES_ACCESS_KEY_ID: draft.ses.accessKeyId,
		AWS_SES_SECRET_ACCESS_KEY: draft.ses.secretAccessKey,
		RESEND_API_KEY: draft.resendKey,
		EMAILIT_API_KEY: draft.emailitKey ?? '',
		SMTP_RELAY_HOST: draft.smtp.host,
		SMTP_RELAY_PORT: draft.smtp.port,
		SMTP_RELAY_SECURE: String(draft.smtp.secure),
		SMTP_RELAY_USERNAME: draft.smtp.username,
		SMTP_RELAY_PASSWORD: draft.smtp.password,
		MANDRILL_API_KEY: draft.mandrillKey,
	};
}

/**
 * Values → draft, the exact inverse of {@link credentialValuesFromDraft} (their
 * round trip is pinned in `__tests__/setupWizardCredentials.test.ts`).
 *
 * `preset` is not a credential and has no env variable — it is the form's memory
 * of WHICH endpoint the operator picked — so it travels beside the values rather
 * than inside them.
 */
export function draftCredentialsFromValues(
	values: TransportCredentialValues,
	preset: SmtpRelayPreset
): DraftCredentials {
	return {
		resendKey: values['RESEND_API_KEY'] ?? '',
		emailitKey: values['EMAILIT_API_KEY'] ?? '',
		mandrillKey: values['MANDRILL_API_KEY'] ?? '',
		ses: {
			region: values['AWS_SES_REGION'] ?? '',
			accessKeyId: values['AWS_SES_ACCESS_KEY_ID'] ?? '',
			secretAccessKey: values['AWS_SES_SECRET_ACCESS_KEY'] ?? '',
		},
		smtp: {
			preset,
			host: values['SMTP_RELAY_HOST'] ?? '',
			port: values['SMTP_RELAY_PORT'] ?? '',
			secure: readBooleanValue(values['SMTP_RELAY_SECURE'], false),
			username: values['SMTP_RELAY_USERNAME'] ?? '',
			password: values['SMTP_RELAY_PASSWORD'] ?? '',
		},
		outboundTlsMode: (values['OUTBOUND_TLS_MODE'] || undefined) as OutboundTlsMode | undefined,
	};
}
