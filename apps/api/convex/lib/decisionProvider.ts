'use node';

/**
 * DECISION provider resolution — the third plane, resolved beside its two
 * neighbours rather than inside them.
 *
 * `lib/llmProvider.ts` is the ONE resolution point for the LANGUAGE and
 * EMBEDDING planes. This module is its sibling for the DECISION plane, and it
 * is a separate file for a plain reason: that one is exactly 500 lines and
 * `scripts/check-file-size.sh` caps a file there. So the plane that was added
 * last gets its own resolver, built the same way, reading the same row.
 *
 * `resolveDecisionConfig(ctx)` produces a typed {@link ResolvedDecisionPlane}
 * from THREE sources, in order, and the order is the whole opt-in posture:
 *
 *   • STORED per-org config (the `aiProviderConfig` row's `decision*` columns)
 *     WINS when the operator has chosen a decision provider. The key is
 *     decrypted ONLY inside the sibling `'use node'` action
 *     `aiProviderConfigActions._decryptSecretEnvelope` — the plaintext never
 *     crosses to a query result or the client.
 *   • ENV `DECISION_*` / `TYPESAFE_API_KEY` is the deployment fallback for a
 *     self-hoster who configures through the environment and never opens the
 *     settings page.
 *   • {@link DEFAULT_DECISION_KIND}, which is `'llm'` and NOT `'typesafe'`.
 *
 * THAT LAST STEP IS THE POINT. A provider with no credential cannot answer, so
 * an install that has entered no key resolves to the language-backed adapter,
 * which is exactly today's behaviour: the same models, the same prompts, the
 * same bill. `typesafe` is what a fresh install's wizard PRE-FILLS and what the
 * settings picker recommends; it is never what an existing deployment is
 * migrated onto. Nothing leaves a deployment until an operator enters their own
 * key, and there is no path through this module that auto-enables one.
 *
 * UNAVAILABLE IS TERMINAL (ADR-0073, owner decision D3). An explicitly
 * configured provider whose credential is missing, malformed or cannot be
 * decrypted, or whose config is invalid, resolves to ITSELF with
 * {@link ResolvedDecisionPlane.unavailable} set. It is never relabelled as the
 * language-backed adapter: that silent re-route bypassed the operator's
 * fallback opt-in and the breaker, and put a paid language call on a path fed
 * by strangers' email. {@link resolveDecisionProvider} throws
 * {@link DecisionProviderUnavailable} for it, so the caller's own fail-soft
 * decides (no decision, never a language call), {@link resolveDecisionFallback}
 * offers no hop, and the settings card shows the reason in words.
 *
 * THE CACHE IS KEYED ON THE ROW'S OWN VERSION, not on a clock. The language
 * plane's cache is a 30 s TTL with no invalidation on save, so an admin who
 * corrects a key waits out the window; a third plane on that scheme would make
 * a miss decrypt three envelopes over three Node round trips. Here the cheap
 * half (one singleton query) runs every time and the expensive half (the Node
 * decrypt round trip, plus resolving a language model we may not need) is what
 * the cache holds, keyed by `updatedAt`. A save bumps that column, so the very
 * next resolution re-decrypts — invalidation on write, without pretending a
 * function call can reach another isolate's memory.
 *
 * Environment (fallback only):
 *   DECISION_PROVIDER   typesafe | local | llm — unrecognised values are ignored
 *   TYPESAFE_API_KEY    the TypeSafe (Jev) key
 *   DECISION_MODEL      model id override — SENT as the model id. Unset ⇒ the
 *                       adapter's pinned version. An answer the provider
 *                       reports against any other version comes back
 *                       `calibrated: false`, so thresholds go inert until the
 *                       calibration harness has been re-run.
 *   DECISION_BASE_URL   API origin override (a proxy in front of the vendor,
 *                       or where the local engine listens when it is not the
 *                       bundled `decision-local` service)
 *
 * `local` needs no key at all: it resolves to the bundled engine at
 * `http://decision-local:8080` unless an origin is configured, and like the
 * language-backed adapter it answers uncalibrated.
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { getOptional } from './env';
import {
	DecisionProviderUnavailable,
	type DecisionUnavailable,
	type ResolvedDecisionProvider,
} from './decision/contract';
import {
	DECISION_PROVIDER_KINDS,
	DEFAULT_DECISION_KIND,
	decisionProviderFor,
	type DecisionEndpointProvenance,
	type DecisionProviderKind,
} from './decisionProviders';
import { resolveLanguageModel } from './llmProvider';
import type { ProviderClientConfig } from './llmProviders/types';

/**
 * One `DECISION_*` value, with empty and whitespace-only treated as unset.
 *
 * A variable declared in a compose file and left blank is the commonest way a
 * self-hosted deployment says "I am not using this", and `??` alone would take
 * `''` as an answer — configuring the plane with an empty model id, or an empty
 * origin the adapter would then append its path to.
 */
function decisionEnv(
	key: 'DECISION_PROVIDER' | 'DECISION_MODEL' | 'DECISION_BASE_URL'
): string | undefined {
	return getOptional(key)?.trim() || undefined;
}

/** Where the resolved kind came from. Surfaced so the settings card can say it. */
export type DecisionConfigSource = 'stored' | 'env' | 'default';

/**
 * The resolved DECISION plane. `clientConfig` is secret-bearing (the decrypted
 * key for a hosted adapter, empty for the language-backed one) and must never
 * be returned from a query or written to a log.
 */
export interface ResolvedDecisionPlane {
	readonly kind: DecisionProviderKind;
	/** Decrypted client config. Empty for `llm`, which carries no key of its own. */
	readonly clientConfig: ProviderClientConfig;
	/** The model id the adapter will be asked for; empty where the plane owns none. */
	readonly modelId: string;
	readonly endpointProvenance: DecisionEndpointProvenance;
	/** The adapter's own answer. Thresholds go inert when this is false. */
	readonly calibrated: boolean;
	/** The per-request budget handed to the dispatch, per adapter. */
	readonly deadlineMs: number;
	readonly source: DecisionConfigSource;
	/**
	 * Set when the configured provider cannot answer (D3): its credential is
	 * missing, malformed or undecryptable, or its config is invalid. `kind`
	 * stays the configured one. Absent on the ordinary path, including the
	 * "nobody configured anything" path, which is the `default` source.
	 */
	readonly unavailable?: DecisionUnavailable;
	/**
	 * The operator's master switch for the fallback hop (`isDecisionFallbackEnabled`).
	 * OFF unless stored true: the hop re-routes onto a model that costs 24 to 50
	 * times more, on a path fed by strangers sending us email.
	 */
	readonly isFallbackEnabled: boolean;
	/** The stored row's `updatedAt`, when resolved from stored config. */
	readonly updatedAt?: number;
}

/**
 * Whether an adapter carries a credential of its own.
 *
 * Not `adapter.isLocal`: the language-backed adapter is not local, it simply
 * answers through the LANGUAGE plane's already-resolved key, so there is
 * nothing for this plane to store or clear for it. Each adapter declares its own
 * requirement, independently of local versus hosted inference.
 */
export function decisionKindNeedsKey(kind: DecisionProviderKind): boolean {
	return decisionProviderFor(kind).requiresApiKey;
}

/**
 * The DEPLOYMENT-level key for a kind, or `undefined` — for one that carries no
 * credential, or one the environment says nothing about.
 *
 * Exported because the save and test actions need the same answer: a deployment
 * that configured itself through `TYPESAFE_API_KEY` has a working decision plane
 * with five empty columns, and a settings page that rejected that save (or a
 * test button that reported "no key") would be wrong about its own install. It
 * is the one place this plane's env variable is named, so no caller has to spell
 * a key's variable to ask whether one exists.
 */
export function decisionEnvApiKey(kind: DecisionProviderKind): string | undefined {
	const key = decisionProviderFor(kind).apiKeyEnv;
	return key === undefined ? undefined : getOptional(key)?.trim() || undefined;
}

/**
 * The kind named by `DECISION_PROVIDER`, or `undefined`. An unrecognised value
 * is IGNORED rather than thrown on, matching how `LLM_PROVIDER` is read one
 * module over: a typo in a deployment variable degrades to the language plane
 * (today's behaviour) instead of taking the inbound path down, and the settings
 * card shows which adapter actually resolved.
 */
function envDecisionKind(): DecisionProviderKind | undefined {
	const configured = decisionEnv('DECISION_PROVIDER');
	return DECISION_PROVIDER_KINDS.find((kind) => kind === configured);
}

/** The per-request budget for a kind: a chat model needs far more than the native endpoint. */
function deadlineForKind(kind: DecisionProviderKind): number {
	return decisionProviderFor(kind).defaultDeadlineMs;
}

/** A complete, decryptable AES-256-GCM envelope read off the decision columns. */
interface DecisionKeyEnvelope {
	ciphertext: string;
	iv: string;
	authTag: string;
	version: number;
}

/**
 * The decision-key envelope of a row, or `undefined` when any of the four
 * columns is absent (no key stored). The five columns are written and cleared in
 * lockstep by `aiProviderConfig._persistConfig`; the fifth — `decisionKeyPreview`
 * — is for the UI and plays no part in decryption, so it is not read here.
 */
function decisionKeyEnvelope(row: Doc<'aiProviderConfig'>): DecisionKeyEnvelope | undefined {
	if (
		row.decisionSecretCiphertext === undefined ||
		row.decisionSecretIv === undefined ||
		row.decisionSecretAuthTag === undefined ||
		row.decisionSecretEnvelopeVersion === undefined
	) {
		return undefined;
	}
	return {
		ciphertext: row.decisionSecretCiphertext,
		iv: row.decisionSecretIv,
		authTag: row.decisionSecretAuthTag,
		version: row.decisionSecretEnvelopeVersion,
	};
}

/** Decrypt one envelope via the Node crypto action (the resolver never holds the key long). */
function decryptEnvelope(ctx: ActionCtx, envelope: DecisionKeyEnvelope): Promise<string> {
	return ctx.runAction(internal.aiProviderConfigActions._decryptSecretEnvelope, envelope);
}

/**
 * The language-backed plane, which is both the default and the degradation
 * target. It carries no client config: the adapter reads none, and handing it an
 * empty object is what says "the key on this plane is the LANGUAGE plane's".
 */
function languageBackedPlane(
	source: DecisionConfigSource,
	isFallbackEnabled: boolean,
	extra: Pick<ResolvedDecisionPlane, 'updatedAt'> = {}
): ResolvedDecisionPlane {
	const adapter = decisionProviderFor('llm');
	return {
		kind: 'llm',
		clientConfig: {},
		modelId: adapter.defaultModel,
		endpointProvenance: adapter.defaultEndpointProvenance,
		calibrated: adapter.calibrated,
		deadlineMs: deadlineForKind('llm'),
		source,
		isFallbackEnabled,
		...extra,
	};
}

/**
 * Whether this config can actually run, asked of the adapter itself rather than
 * guessed at here. Returns the adapter's own message so the unavailable state can
 * be read by a human; adapters state the mistake, never the credential.
 */
function credentialFailure(
	kind: DecisionProviderKind,
	clientConfig: ProviderClientConfig
): DecisionUnavailable | undefined {
	try {
		decisionProviderFor(kind).validateCredentials(clientConfig);
		return undefined;
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : 'The decision provider is not configured.';
		const needsKey = decisionKindNeedsKey(kind);
		return {
			code:
				needsKey && clientConfig.apiKey === undefined ? 'missing_credentials' : 'invalid_config',
			reason,
		};
	}
}

/**
 * The client config a kind runs under: the stored key and origin, with the
 * deployment's own values filling each gap.
 *
 * THE ONE PLACE this plane's stored-then-env precedence for a credential is
 * written. `planeFor` resolves through it and so does the settings test button,
 * so a test can never answer for a different config than the one that would
 * answer a decision — which is the failure mode of every "test connection"
 * button that reimplements resolution.
 */
export function decisionClientConfigFor(
	kind: DecisionProviderKind,
	storedKey: string | undefined,
	storedBaseUrl: string | undefined
): ProviderClientConfig {
	const apiKey = decisionKindNeedsKey(kind) ? (storedKey ?? decisionEnvApiKey(kind)) : undefined;
	// An explicit origin is the operator's, from either source; the adapter's own
	// default is NOT one, which is exactly the distinction the provenance draws
	// between a native endpoint and a proxy in front of it.
	const baseUrl = storedBaseUrl ?? decisionEnv('DECISION_BASE_URL');
	return {
		...(apiKey !== undefined ? { apiKey } : {}),
		...(baseUrl !== undefined ? { baseUrl } : {}),
	};
}

/**
 * Assemble the plane for a chosen kind, degrading to the language-backed
 * adapter when the credential cannot answer. `storedKey` is the decrypted
 * stored key (already fetched through the Node action) and loses to nothing —
 * the env key is only consulted when no key is stored, which is what makes a
 * stored config the authoritative one.
 */
function planeFor(input: {
	kind: DecisionProviderKind;
	source: DecisionConfigSource;
	storedKey: string | undefined;
	storedModel: string | undefined;
	storedBaseUrl: string | undefined;
	isFallbackEnabled: boolean;
	updatedAt: number | undefined;
	/** The stored key could not be decrypted (D3: terminal, never a language call). */
	decryptFailure?: DecisionUnavailable;
}): ResolvedDecisionPlane {
	const { kind, source, isFallbackEnabled, updatedAt } = input;
	// Only the language-backed adapter delegates its model and endpoint to that plane.
	// A future keyless decision engine must still resolve its own configuration.
	if (kind === 'llm') {
		return languageBackedPlane(source, isFallbackEnabled, { updatedAt });
	}
	const adapter = decisionProviderFor(kind);
	const clientConfig = decisionClientConfigFor(kind, input.storedKey, input.storedBaseUrl);

	const failure = input.decryptFailure ?? credentialFailure(kind, clientConfig);

	return {
		kind,
		// An unavailable plane carries no client: nothing may be sent with it.
		clientConfig: failure === undefined ? clientConfig : {},
		...(failure === undefined ? {} : { unavailable: failure }),
		modelId: input.storedModel ?? decisionEnv('DECISION_MODEL') ?? adapter.defaultModel,
		// An origin override turns a HOSTED endpoint into an unknown third party;
		// a local engine is the operator's own wherever its origin points.
		endpointProvenance:
			clientConfig.baseUrl !== undefined && !adapter.isLocal
				? 'custom'
				: adapter.defaultEndpointProvenance,
		calibrated: adapter.calibrated,
		deadlineMs: deadlineForKind(kind),
		source,
		isFallbackEnabled,
		updatedAt,
	};
}

// The resolved plane, keyed by the version of the config it was built from — see
// the header. `stored:<updatedAt>` changes on every save, and a row that is
// deleted (or never written) collapses onto the one env signature, so the only
// way to read a stale plane is to not have changed anything.
let planeCache: { signature: string; plane: ResolvedDecisionPlane } | null = null;

function signatureOf(row: Doc<'aiProviderConfig'> | null): string {
	return row ? `stored:${row._id}:${row.updatedAt}` : 'env';
}

/**
 * Resolve the org's DECISION plane: the stored row's `decision*` columns win,
 * then the `DECISION_*` environment, then the language-backed default. The one
 * point every decision resolution flows through, and the only place this plane's
 * key is decrypted.
 *
 * The decision columns are ALL optional, so an existing install — whose row was
 * written before this plane existed — takes the env branch and then the default
 * branch, and answers exactly as it did yesterday. That is the upgrade story:
 * no migration, no banner, no preselected vendor.
 */
export async function resolveDecisionConfig(ctx: ActionCtx): Promise<ResolvedDecisionPlane> {
	const row = await ctx.runQuery(internal.aiProviderConfig._getConfigRow, {});
	const signature = signatureOf(row);
	const cached = planeCache;
	if (cached && cached.signature === signature) return cached.plane;

	const plane = await buildPlane(ctx, row);
	planeCache = { signature, plane };
	return plane;
}

/** The uncached resolution, split out so the cache above reads as a cache. */
async function buildPlane(
	ctx: ActionCtx,
	row: Doc<'aiProviderConfig'> | null
): Promise<ResolvedDecisionPlane> {
	const isFallbackEnabled = row?.isDecisionFallbackEnabled === true;
	const storedKind = row?.decisionProviderKind;
	if (row && storedKind !== undefined) {
		// Decrypt ONLY inside the Node action, and only for an adapter that has a
		// credential to decrypt. The plaintext builds a client config and is
		// discarded with it; it never reaches a query result or the client.
		const envelope = decisionKindNeedsKey(storedKind) ? decisionKeyEnvelope(row) : undefined;
		let storedKey: string | undefined;
		let decryptFailure: DecisionUnavailable | undefined;
		try {
			storedKey = envelope ? await decryptEnvelope(ctx, envelope) : undefined;
		} catch {
			decryptFailure = {
				code: 'undecryptable',
				reason: 'The stored decision provider key cannot be decrypted. Enter the key again.',
			};
		}
		return planeFor({
			kind: storedKind,
			source: 'stored',
			storedKey,
			...(decryptFailure ? { decryptFailure } : {}),
			storedModel: row.decisionModel,
			storedBaseUrl: row.decisionBaseUrl,
			isFallbackEnabled,
			updatedAt: row.updatedAt,
		});
	}

	const envKind = envDecisionKind();
	if (envKind !== undefined) {
		return planeFor({
			kind: envKind,
			source: 'env',
			storedKey: undefined,
			storedModel: undefined,
			storedBaseUrl: undefined,
			isFallbackEnabled,
			updatedAt: row?.updatedAt,
		});
	}

	// Nobody opted in. Not a degradation — the deployment simply keeps answering
	// decisions the way it always has, through the one kind that needs no key.
	return planeFor({
		kind: DEFAULT_DECISION_KIND,
		source: 'default',
		storedKey: undefined,
		storedModel: undefined,
		storedBaseUrl: undefined,
		isFallbackEnabled,
		updatedAt: row?.updatedAt,
	});
}

/**
 * The resolved plane in the shape `lib/decision/dispatch.runDecision` takes.
 * The LANGUAGE model is resolved LAZILY — only the language-backed adapter needs
 * one, and resolving it for the native adapter would decrypt the language key on
 * every decision for nothing.
 */
export async function resolveDecisionProvider(ctx: ActionCtx): Promise<ResolvedDecisionProvider> {
	const plane = await resolveDecisionConfig(ctx);
	// D3: an explicit provider that cannot answer is terminal. Nothing is
	// resolved on the language plane for it.
	if (plane.unavailable) throw new DecisionProviderUnavailable(plane.kind, plane.unavailable);
	return {
		kind: plane.kind,
		config: plane.clientConfig,
		deadlineMs: plane.deadlineMs,
		// The id the three sources settled on, carried to the adapter rather than
		// computed and dropped: a version an operator stored, saw echoed back and
		// then never had sent is worse than not offering the field at all. The
		// language-backed plane has none of its own — the LANGUAGE plane owns that
		// answer — so an empty id travels as absent.
		...(plane.modelId ? { modelId: plane.modelId } : {}),
		...(plane.kind === 'llm' ? { model: await resolveLanguageModel(ctx, 'classify') } : {}),
	};
}

/**
 * The fallback plane to hand `runDecision`, or `undefined` — and `undefined` is
 * the default, because ABSENT MEANS NO HOP. Four ways to get there: the
 * operator never turned the hop on, the primary already IS the language plane
 * (hopping to itself would only double the bill of a failure), or the plane
 * cannot answer at all (D3: terminal, so there is no failure for a hop to cover).
 *
 * A caller that must never hop — the high-volume background classifiers, where
 * an outage becomes a bill rather than an incident — simply does not call this.
 */
export async function resolveDecisionFallback(
	ctx: ActionCtx
): Promise<ResolvedDecisionProvider | undefined> {
	const plane = await resolveDecisionConfig(ctx);
	// D3: no hop for a provider that cannot answer at all; the hop is for an
	// operational failure of a working provider.
	if (!plane.isFallbackEnabled || plane.kind === 'llm' || plane.unavailable) return undefined;
	return {
		kind: 'llm',
		config: {},
		deadlineMs: deadlineForKind('llm'),
		model: await resolveLanguageModel(ctx, 'classify'),
	};
}

/** Test-only: drop the in-process plane cache so a fresh resolution runs. */
export function __resetDecisionPlaneCacheForTests(): void {
	planeCache = null;
}
