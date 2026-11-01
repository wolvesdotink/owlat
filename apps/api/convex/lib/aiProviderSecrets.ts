/**
 * Which stored key each plane of the `aiProviderConfig` row keeps on a save.
 *
 * Every plane owns five secret columns (the AES-GCM four plus a masked preview),
 * written and cleared in lockstep. Secrets never round-trip through the client,
 * so a save that enters no key re-persists the stored one, but only for the same
 * target: a key belongs to one provider kind at one endpoint. When the provider
 * kind or the normalized base URL of a plane changes, the stored key is not
 * carried over and the save needs a newly entered key.
 *
 * Pure and v8-safe: the settings mutation (`aiRouting/providerConfig.ts`) calls it with
 * already-encrypted envelopes; nothing here decrypts.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { isSameKeyTarget, type KeyTarget } from '@owlat/shared/aiModelCatalog';
import { throwInvalidInput } from '../_utils/errors';
import type { DecisionProviderKind } from './decisionProviders/types';

/** A freshly-encrypted key envelope handed over by the Node save action. */
export const envelopeValidator = v.object({
	ciphertext: v.string(),
	iv: v.string(),
	authTag: v.string(),
	version: v.number(),
	keyPreview: v.string(),
});

export type Envelope = {
	ciphertext: string;
	iv: string;
	authTag: string;
	version: number;
	keyPreview: string;
};

/** A possibly-incomplete envelope read back off an existing row. */
interface StoredEnvelope {
	ciphertext?: string;
	iv?: string;
	authTag?: string;
	version?: number;
	keyPreview?: string;
}

type Plane = 'language' | 'embedding' | 'decision';

/** `data.reason` when a save needs a new key because the plane's target changed. */
export const STORED_KEY_NOT_REUSABLE = 'stored_key_not_reusable';

/** Map the stored envelope columns of one plane off an existing config row. */
function storedEnvelopeOf(row: Doc<'aiProviderConfig'>, plane: Plane): StoredEnvelope {
	switch (plane) {
		case 'language':
			return {
				ciphertext: row.secretCiphertext,
				iv: row.secretIv,
				authTag: row.secretAuthTag,
				version: row.secretEnvelopeVersion,
				keyPreview: row.keyPreview,
			};
		case 'embedding':
			return {
				ciphertext: row.embeddingSecretCiphertext,
				iv: row.embeddingSecretIv,
				authTag: row.embeddingSecretAuthTag,
				version: row.embeddingSecretEnvelopeVersion,
				keyPreview: row.embeddingKeyPreview,
			};
		case 'decision':
			return {
				ciphertext: row.decisionSecretCiphertext,
				iv: row.decisionSecretIv,
				authTag: row.decisionSecretAuthTag,
				version: row.decisionSecretEnvelopeVersion,
				keyPreview: row.decisionKeyPreview,
			};
	}
}

function completeEnvelope(e: StoredEnvelope): Envelope | undefined {
	if (
		e.ciphertext === undefined ||
		e.iv === undefined ||
		e.authTag === undefined ||
		e.version === undefined ||
		e.keyPreview === undefined
	) {
		return undefined;
	}
	return {
		ciphertext: e.ciphertext,
		iv: e.iv,
		authTag: e.authTag,
		version: e.version,
		keyPreview: e.keyPreview,
	};
}

/**
 * Decide the final stored key envelope for one plane. A freshly-entered key
 * wins. Otherwise the stored envelope is kept, but only while the plane still
 * targets the same provider kind and endpoint. A local, keyless provider clears
 * any stored key. A hosted provider with no usable key is rejected: we never
 * persist a hosted config that can't run.
 *
 * `isKeyRequired` relaxes that last rule for the one case where it is wrong: a
 * deployment that supplies the DECISION key through its environment has a
 * working config with nothing in these columns.
 */
function resolveSecret(input: {
	plane: Plane;
	isLocal: boolean;
	isKeyRequired?: boolean;
	envelope?: Envelope;
	existing: Doc<'aiProviderConfig'> | null;
	previous: KeyTarget;
	next: KeyTarget;
}): Envelope | undefined {
	if (input.isLocal) return undefined;
	if (input.envelope) return input.envelope;
	const stored = input.existing
		? completeEnvelope(storedEnvelopeOf(input.existing, input.plane))
		: undefined;
	const isReusable = isSameKeyTarget(input.previous, input.next);
	if (stored && isReusable) return stored;
	if (input.isKeyRequired === false) return undefined;
	if (stored) {
		throwInvalidInput(
			`The ${input.plane} provider or its base URL changed, so the stored API key no ` +
				`longer applies. Enter the API key for the new ${input.plane} provider.`,
			{ reason: STORED_KEY_NOT_REUSABLE, plane: input.plane }
		);
	}
	throwInvalidInput(`The ${input.plane} provider requires an API key.`);
}

/** The DECISION plane's nine columns, as written onto the row. */
interface DecisionColumns {
	decisionProviderKind?: DecisionProviderKind;
	decisionModel?: string;
	decisionBaseUrl?: string;
	isDecisionFallbackEnabled?: boolean;
	decisionSecretCiphertext?: string;
	decisionSecretIv?: string;
	decisionSecretAuthTag?: string;
	decisionSecretEnvelopeVersion?: number;
	decisionKeyPreview?: string;
}

/** The plane selections and newly encrypted keys a settings save carries. */
export interface PlaneSecretArgs {
	languageProviderKind: string;
	languageBaseUrl?: string;
	isLanguageLocal: boolean;
	languageEnvelope?: Envelope;
	embeddingProviderKind: string;
	isEmbeddingLocal: boolean;
	embeddingEnvelope?: Envelope;
	decisionProviderKind?: DecisionProviderKind;
	decisionModel?: string;
	decisionBaseUrl?: string;
	isDecisionFallbackEnabled?: boolean;
	isDecisionKeyless?: boolean;
	hasDecisionEnvKey?: boolean;
	decisionEnvelope?: Envelope;
}

/**
 * The decision columns a save should write.
 *
 * TWO BRANCHES, and the first one is the important one. A save that names no
 * decision kind — every caller written before this plane existed, and any
 * settings save that only touches the language or embedding cards — carries the
 * existing columns forward verbatim. `ctx.db.patch` treats `undefined` as a
 * CLEAR, so omitting them would quietly switch a configured decision plane off
 * and throw the key away with it.
 *
 * The second branch writes the plane, with the five secret columns resolved in
 * lockstep by {@link resolveSecret}: a keyless adapter clears all five, a newly
 * entered key replaces all five, and a stored one is re-persisted only for the
 * same provider kind and base URL.
 */
function resolveDecisionColumns(
	args: PlaneSecretArgs,
	existing: Doc<'aiProviderConfig'> | null
): DecisionColumns {
	if (args.decisionProviderKind === undefined) {
		return {
			decisionProviderKind: existing?.decisionProviderKind,
			decisionModel: existing?.decisionModel,
			decisionBaseUrl: existing?.decisionBaseUrl,
			isDecisionFallbackEnabled: existing?.isDecisionFallbackEnabled,
			decisionSecretCiphertext: existing?.decisionSecretCiphertext,
			decisionSecretIv: existing?.decisionSecretIv,
			decisionSecretAuthTag: existing?.decisionSecretAuthTag,
			decisionSecretEnvelopeVersion: existing?.decisionSecretEnvelopeVersion,
			decisionKeyPreview: existing?.decisionKeyPreview,
		};
	}
	const secret = resolveSecret({
		plane: 'decision',
		isLocal: args.isDecisionKeyless === true,
		// A key the deployment already supplies through TYPESAFE_API_KEY is a
		// working config with empty columns — see `resolveSecret`.
		isKeyRequired: args.hasDecisionEnvKey !== true,
		envelope: args.decisionEnvelope,
		existing,
		previous: { kind: existing?.decisionProviderKind, baseUrl: existing?.decisionBaseUrl },
		next: { kind: args.decisionProviderKind, baseUrl: args.decisionBaseUrl },
	});
	return {
		decisionProviderKind: args.decisionProviderKind,
		decisionModel: args.decisionModel,
		decisionBaseUrl: args.decisionBaseUrl,
		isDecisionFallbackEnabled: args.isDecisionFallbackEnabled,
		decisionSecretCiphertext: secret?.ciphertext,
		decisionSecretIv: secret?.iv,
		decisionSecretAuthTag: secret?.authTag,
		decisionSecretEnvelopeVersion: secret?.version,
		decisionKeyPreview: secret?.keyPreview,
	};
}

/**
 * The key envelope each plane writes. The embedding plane stores no base URL (a
 * hosted embedder uses its provider's endpoint), so its key follows the kind alone.
 */
export function resolvePlaneSecrets(
	args: PlaneSecretArgs,
	existing: Doc<'aiProviderConfig'> | null
): {
	language: Envelope | undefined;
	embedding: Envelope | undefined;
	decision: DecisionColumns;
} {
	return {
		language: resolveSecret({
			plane: 'language',
			isLocal: args.isLanguageLocal,
			envelope: args.languageEnvelope,
			existing,
			previous: { kind: existing?.languageProviderKind, baseUrl: existing?.languageBaseUrl },
			next: { kind: args.languageProviderKind, baseUrl: args.languageBaseUrl },
		}),
		embedding: resolveSecret({
			plane: 'embedding',
			isLocal: args.isEmbeddingLocal,
			envelope: args.embeddingEnvelope,
			existing,
			previous: { kind: existing?.embeddingProviderKind, baseUrl: undefined },
			next: { kind: args.embeddingProviderKind, baseUrl: undefined },
		}),
		decision: resolveDecisionColumns(args, existing),
	};
}
