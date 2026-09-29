/**
 * Catalog credential values → the setup config's `sending` block.
 *
 * Two programs hold a send provider's credentials as the catalog's
 * `credentialFields` describe them (values keyed by the env variable each field
 * writes) and need a {@link SendingConfig} out of them: the desktop "set up a new
 * server" wizard, which renders the catalog's credential form and uploads the
 * config over SSH, and setup-cli's `--assume-yes` path, which reads the same
 * variables from the environment. Both call {@link sendingConfigFromCredentials},
 * so neither restates a provider's fields.
 *
 * NO PER-PROVIDER CODE. The mapping is per FIELD KIND: a `host-port` composite
 * becomes `host` / `port` / `secure`, every other field becomes the property
 * named by its `key`. That works because the config's property names ARE the
 * catalog's field keys, and `_SendingConfigMatchesCatalog` below fails the build
 * the day they stop being.
 */

import {
	CORE_SEND_PROVIDER_CATALOG_ENTRIES,
	type CoreSendProviderCatalogEntry,
	type SendProviderCredentialField,
} from './sendProviderCatalog';
import type { CORE_SEND_PROVIDER_CATALOG } from './sendProviderCatalogData';
import type { SendingConfig } from './setupConfigTypes';

/** A kind the setup config can carry. */
export type SetupSendingKind = SendingConfig['provider'];

/**
 * The kinds {@link SendingConfig} has a variant for. A `Record` over the union,
 * so a variant added to (or dropped from) the config type is a compile error
 * here. Catalog kinds outside it (Mandrill, bundled plugins) cannot be written
 * to a setup config.
 */
const SETUP_SENDING_KINDS: Record<SetupSendingKind, true> = {
	mta: true,
	ses: true,
	resend: true,
	smtp: true,
	emailit: true,
};

/** True iff `kind` has a {@link SendingConfig} variant. */
export function isSetupSendingKind(kind: string | null | undefined): kind is SetupSendingKind {
	return kind != null && Object.hasOwn(SETUP_SENDING_KINDS, kind);
}

/** The catalog entries a setup config can carry, in catalog order. */
export const SETUP_SENDING_CATALOG_ENTRIES: readonly CoreSendProviderCatalogEntry[] = Object.freeze(
	CORE_SEND_PROVIDER_CATALOG_ENTRIES.filter((e) => isSetupSendingKind(e.kind))
);

/** Why a set of credential values does not make a config. */
export interface SendingCredentialProblem {
	readonly field: SendProviderCredentialField;
	/** `missing`: a required field is blank. `invalid`: the value is not one the field accepts. */
	readonly reason: 'missing' | 'invalid';
}

export type SendingConfigResult =
	| { readonly ok: true; readonly config: SendingConfig }
	| { readonly ok: false; readonly problem: SendingCredentialProblem };

/** Reads one credential value by the env variable its field writes. */
export type CredentialValueReader = (envVar: string) => string | undefined;

/**
 * Build the `sending` block for `kind` from its catalog credential fields.
 *
 * Identifiers (host, username, region, key id) are trimmed; a `secret` is
 * written verbatim, as the web credential form writes it, and only checked for
 * blankness. A blank optional field is left out so setup-cli's default applies.
 * Returns the first problem in field order when a required value is blank or a
 * value is malformed (a port that is not 1–65535, an option the field does not
 * declare).
 */
export function sendingConfigFromCredentials(
	kind: SetupSendingKind,
	read: CredentialValueReader
): SendingConfigResult {
	const entry = SETUP_SENDING_CATALOG_ENTRIES.find((e) => e.kind === kind);
	const props: Record<string, string | number | boolean> = {};
	for (const field of entry?.credentialFields ?? []) {
		const problem = readField(field, read, props);
		if (problem) return { ok: false, problem: { field, reason: problem } };
	}
	return { ok: true, config: { provider: kind, ...props } as SendingConfig };
}

function readField(
	field: SendProviderCredentialField,
	read: CredentialValueReader,
	into: Record<string, string | number | boolean>
): SendingCredentialProblem['reason'] | undefined {
	const text = (envVar: string) => (read(envVar) ?? '').trim();
	const value = text(field.envVar);

	if (field.kind === 'host-port') {
		if (value === '') return field.required ? 'missing' : undefined;
		into['host'] = value;
		const port = text(field.portEnvVar);
		if (port !== '') {
			const parsed = parsePort(port);
			if (parsed === undefined) return 'invalid';
			into['port'] = parsed;
		}
		const secure = parseBoolean(text(field.secureEnvVar));
		if (secure !== undefined) into['secure'] = secure;
		return undefined;
	}

	if (field.kind === 'select') {
		const chosen = value || field.default || '';
		if (chosen === '') return field.required ? 'missing' : undefined;
		if (!field.options.some((option) => option.value === chosen)) return 'invalid';
		into[field.key] = chosen;
		return undefined;
	}

	if (value === '') return field.required ? 'missing' : undefined;

	if (field.kind === 'secret') {
		into[field.key] = read(field.envVar) ?? '';
		return undefined;
	}
	if (field.kind === 'boolean') {
		const parsed = parseBoolean(value);
		if (parsed === undefined) return 'invalid';
		into[field.key] = parsed;
		return undefined;
	}
	if (field.kind === 'number') {
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) return 'invalid';
		into[field.key] = parsed;
		return undefined;
	}
	if (field.kind === 'region-select' && field.options) {
		if (!field.options.some((option) => option.value === value)) return 'invalid';
	}
	into[field.key] = value;
	return undefined;
}

function parsePort(raw: string): number | undefined {
	if (!/^\d+$/.test(raw)) return undefined;
	const port = Number(raw);
	return port >= 1 && port <= 65535 ? port : undefined;
}

function parseBoolean(raw: string): boolean | undefined {
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	return undefined;
}

// ── Compile-time pin: config properties ⇔ catalog field keys ─────────────────

type CatalogEntryOf<K> = Extract<(typeof CORE_SEND_PROVIDER_CATALOG)[number], { kind: K }>;
type ConfigKeysOfField<F> = F extends { kind: 'host-port' }
	? 'host' | 'port' | 'secure'
	: F extends { key: infer Key }
		? Key
		: never;
type FieldKeys<K> = ConfigKeysOfField<CatalogEntryOf<K>['credentialFields'][number]>;
type VariantKeys<K> = Exclude<keyof Extract<SendingConfig, { provider: K }>, 'provider'>;
type Mismatched = {
	[K in SetupSendingKind]: [FieldKeys<K>] extends [VariantKeys<K>]
		? [VariantKeys<K>] extends [FieldKeys<K>]
			? never
			: K
		: K;
}[SetupSendingKind];

type AssertNoMismatch<_K extends never> = true;

/**
 * Compiles only while every {@link SendingConfig} variant's properties are
 * exactly the property names its catalog entry's fields map to. On a mismatch
 * the error names the kind.
 */
type _SendingConfigMatchesCatalog = AssertNoMismatch<Mismatched>;
