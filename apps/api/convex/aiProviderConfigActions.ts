'use node';

/**
 * Pluggable AI providers (bring-your-own-key) — Node-runtime surface.
 *
 * Runs in Convex's Node.js runtime (`'use node'`) because key encryption /
 * decryption uses `node:crypto` via `lib/credentialCrypto`. All DB work is
 * delegated to the sibling v8 file `aiProviderConfig.ts`; the BetterAuth
 * session propagates from these public actions into those internal calls.
 *
 *   Public:  saveConfig     — encrypt the plaintext key (AES-256-GCM envelope,
 *                             like externalMailAccounts) and persist via the
 *                             admin-gated internal mutation. The plaintext key
 *                             crosses to the backend once over TLS and is NEVER
 *                             returned or logged.
 *            testConnection — decrypt the stored key and call the adapter's
 *                             `validateCredentials` (hosted) or probe the base
 *                             URL (local); for the DECISION plane, ask the
 *                             provider one real question. Rate-limited. Returns
 *                             `{ ok, error }`.
 *
 * Three planes share the row, and the DECISION one is opt-in end to end: a save
 * that names no decision kind leaves its nine columns exactly as they were, and
 * `testConnection` / `listModels` take a `plane` argument that defaults to
 * `language`, so every existing caller behaves as it did.
 */

import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { authedAction } from './lib/authedFunctions';
import { decryptSecret, encryptSecret } from './lib/credentialCrypto';
import { embeddingProviderFor, languageProviderFor } from './lib/llmProviders';
import { decisionProviderFor } from './lib/decisionProviders';
import { decisionEnvApiKey, decisionKindNeedsKey } from './lib/decisionProvider';
import { listDecisionModels, testDecisionPlane } from './lib/decision/settingsActions';
import { fetchGuarded } from './lib/ssrfGuard';
import { validateOutboundUrl } from './lib/outboundUrlValidation';
import { rateLimiter } from './rateLimiter';
import { throwUnauthenticated } from './_utils/errors';
import {
	decisionProviderKindValidator,
	embeddingProviderKindValidator,
	languageProviderKindValidator,
} from './lib/aiProviderConfigValidators';

/** Which plane a test / discovery call is about. Absent ⇒ `language`, as before. */
const planeValidator = v.optional(v.union(v.literal('language'), v.literal('decision')));

/** Non-secret masked preview of a key for the settings UI (e.g. `sk-…a1b2`). */
function keyPreview(key: string): string {
	if (key.length <= 8) return '••••';
	return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** Encrypt a plaintext key into the persisted envelope shape + a masked preview. */
function envelopeFor(key: string) {
	const e = encryptSecret(key);
	return {
		ciphertext: e.ciphertext,
		iv: e.iv,
		authTag: e.authTag,
		version: e.version,
		keyPreview: keyPreview(key),
	};
}

/**
 * Decrypt the LANGUAGE plane's stored key, or `undefined` when any of its four
 * envelope columns is absent.
 *
 * The read side of the lockstep the persist mutation writes, spelled once here
 * rather than inline at each call site (it was inlined twice). The decision
 * plane's identical read lives beside its own settings actions in
 * `lib/decision/settingsActions.ts`; the two are one prefix apart and deliberately
 * not one parameterised helper, because a plane mix-up there is a key sent to
 * the wrong vendor.
 */
function storedLanguageKey(row: Doc<'aiProviderConfig'>): string | undefined {
	if (
		row.secretCiphertext === undefined ||
		row.secretIv === undefined ||
		row.secretAuthTag === undefined ||
		row.secretEnvelopeVersion === undefined
	) {
		return undefined;
	}
	return decryptSecret({
		ciphertext: row.secretCiphertext,
		iv: row.secretIv,
		authTag: row.secretAuthTag,
		version: row.secretEnvelopeVersion,
	});
}

/**
 * Save the org's AI-provider config. Encrypts any newly-entered key, then hands
 * off to the admin-gated internal mutation (which enforces `organization:manage`
 * + audit-logs the change). An omitted `apiKey` keeps the stored key; a local
 * language provider needs none.
 */
// authz: admin gate is enforced in the delegated internal mutation
// `aiProviderConfig._persistConfig` (requireOrgPermission 'organization:manage'),
// which also records the audit log — actions can't read ctx.db to gate here.
export const saveConfig = authedAction({
	args: {
		languageProviderKind: languageProviderKindValidator,
		languageBaseUrl: v.optional(v.string()),
		modelFast: v.optional(v.string()),
		modelCapable: v.optional(v.string()),
		/** Plaintext language-provider key. Omit to keep the stored key unchanged. */
		apiKey: v.optional(v.string()),
		embeddingProviderKind: v.optional(embeddingProviderKindValidator),
		embeddingModel: v.optional(v.string()),
		/** Plaintext hosted-embedder key. Omit to keep the stored key unchanged. */
		embeddingApiKey: v.optional(v.string()),
		// The DECISION plane. OMITTING `decisionProviderKind` LEAVES IT UNTOUCHED —
		// it is not a request to clear it, so a settings page that only edits the
		// language card cannot switch a configured decision plane off.
		decisionProviderKind: v.optional(decisionProviderKindValidator),
		decisionModel: v.optional(v.string()),
		decisionBaseUrl: v.optional(v.string()),
		isDecisionFallbackEnabled: v.optional(v.boolean()),
		/** Plaintext decision-provider key. Omit to keep the stored key unchanged. */
		decisionApiKey: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<Id<'aiProviderConfig'>> => {
		const adapter = languageProviderFor(args.languageProviderKind);
		const modelFast = args.modelFast?.trim() || adapter.defaultModels.fast;
		const modelCapable = args.modelCapable?.trim() || adapter.defaultModels.capable;
		const languageBaseUrl = args.languageBaseUrl?.trim() || undefined;

		// Fail fast on structurally-invalid config before persisting anything.
		if (adapter.isLocal) {
			adapter.validateCredentials({ baseUrl: languageBaseUrl ?? adapter.defaultBaseUrl });
		} else if (args.apiKey) {
			adapter.validateCredentials({ apiKey: args.apiKey, baseUrl: languageBaseUrl });
		}

		// Local by default; the adapter decides whether it is keyless (local /
		// custom-compatible) or a hosted embedder that needs a key.
		const embeddingProviderKind = args.embeddingProviderKind ?? 'local';
		const embeddingAdapter = embeddingProviderFor(embeddingProviderKind);
		const isEmbeddingLocal = embeddingAdapter.isLocal;
		// Fail fast on a hosted embedder configured with a key but structurally
		// invalid, before persisting anything.
		if (!isEmbeddingLocal && args.embeddingApiKey) {
			embeddingAdapter.validateCredentials({
				apiKey: args.embeddingApiKey,
				modelId: args.embeddingModel?.trim() || embeddingAdapter.defaultModel,
			});
		}

		// The decision plane, when (and only when) this save names one. A newly
		// entered key is validated before anything is persisted, exactly like the
		// language one; a key the deployment already supplies through its own
		// environment is not re-entered here and must not make the save fail.
		const decisionKind = args.decisionProviderKind;
		const decisionBaseUrl = args.decisionBaseUrl?.trim() || undefined;
		if (decisionKind !== undefined && args.decisionApiKey) {
			decisionProviderFor(decisionKind).validateCredentials({
				apiKey: args.decisionApiKey,
				baseUrl: decisionBaseUrl,
			});
		}

		return await ctx.runMutation(internal.aiProviderConfig._persistConfig, {
			languageProviderKind: args.languageProviderKind,
			languageBaseUrl,
			modelFast,
			modelCapable,
			isLanguageLocal: adapter.isLocal,
			languageEnvelope: args.apiKey ? envelopeFor(args.apiKey) : undefined,
			embeddingProviderKind,
			embeddingModel: args.embeddingModel?.trim() || undefined,
			isEmbeddingLocal,
			embeddingEnvelope: args.embeddingApiKey ? envelopeFor(args.embeddingApiKey) : undefined,
			decisionProviderKind: decisionKind,
			decisionModel: args.decisionModel?.trim() || undefined,
			decisionBaseUrl,
			isDecisionFallbackEnabled: args.isDecisionFallbackEnabled,
			isDecisionKeyless:
				decisionKind !== undefined ? !decisionKindNeedsKey(decisionKind) : undefined,
			hasDecisionEnvKey:
				decisionKind !== undefined ? decisionEnvApiKey(decisionKind) !== undefined : undefined,
			decisionEnvelope: args.decisionApiKey ? envelopeFor(args.decisionApiKey) : undefined,
		});
	},
});

/**
 * Test the stored language provider. For a hosted provider it decrypts the key
 * and runs the adapter's `validateCredentials`; for a local provider it probes
 * the base URL for reachability. Persists nothing, returns only `{ ok, error }`
 * (never the key). Rate-limited per user.
 */
// authz: admin floor (organization:manage) via internal.auth.membership
// .assertOrgAdmin — the only caller is the admin instance-settings page, and
// the local-provider branch fires an outbound request at an admin-configured
// base URL, so a member should not be able to trigger it.
export const testConnection = authedAction({
	args: { plane: planeValidator },
	handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
		// Admin floor — actions can't run requireOrgPermission directly, so
		// assert through the internal query that inherits our identity.
		await ctx.runQuery(internal.auth.membership.assertOrgAdmin, {});

		// `authedAction` has already asserted org membership, so an identity is
		// guaranteed here; narrow it (rather than an unreachable 'anonymous'
		// fallback) so distinct callers never collapse onto one rate-limit bucket.
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throwUnauthenticated();
		const rl = await rateLimiter.limit(ctx, 'aiProviderConfigTest', {
			key: identity.subject,
		});
		if (!rl.ok) {
			return { ok: false, error: 'Too many connection tests — try again in a moment.' };
		}

		const row = await ctx.runQuery(internal.aiProviderConfig._getConfigRow, {});
		if (!row) return { ok: false, error: 'No AI provider is configured yet.' };

		if (args.plane === 'decision') return await testDecisionPlane(ctx);

		const adapter = languageProviderFor(row.languageProviderKind);
		try {
			if (adapter.isLocal) {
				const baseUrl = row.languageBaseUrl ?? adapter.defaultBaseUrl;
				if (!baseUrl) {
					return { ok: false, error: 'This local provider has no base URL configured.' };
				}
				// A local provider legitimately targets http://localhost (so the private
				// range can't be blocked here), but the URL must still be a shape we
				// accept, and the probe must refuse redirects (no 30x hop to an internal
				// host) and time out.
				const check = validateOutboundUrl(baseUrl, { requirePublic: false });
				if (!check.ok) {
					return { ok: false, error: `Base URL ${check.error}.` };
				}
				// Any HTTP response (even a 404) proves the endpoint is reachable.
				await fetch(check.url.toString(), {
					method: 'GET',
					redirect: 'manual',
					signal: AbortSignal.timeout(5000),
				});
				return { ok: true };
			}
			const apiKey = storedLanguageKey(row);
			adapter.validateCredentials({ apiKey, baseUrl: row.languageBaseUrl });
			return { ok: true };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : 'Connection test failed.' };
		}
	},
});

/**
 * List the models the STORED language provider exposes, for the settings model
 * picker. Only the OpenRouter and local (OpenAI-compatible) adapters implement
 * discovery — for the rest (or when nothing is configured) `supported` is false
 * and the picker stays free-text. Decrypts the stored key (hosted) only to fetch
 * the provider's `/models`; returns just the ids (never the key). Rate-limited
 * per user, and fails soft: a listing error is returned inline, never thrown.
 */
// authz: admin floor (organization:manage) via internal.auth.membership
// .assertOrgAdmin — mirrors `testConnection` above (same admin-only caller,
// same outbound request against the stored base URL).
export const listModels = authedAction({
	args: { plane: planeValidator },
	handler: async (ctx, args): Promise<{ supported: boolean; models: string[]; error?: string }> => {
		// Admin floor — see testConnection.
		await ctx.runQuery(internal.auth.membership.assertOrgAdmin, {});

		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throwUnauthenticated();
		const rl = await rateLimiter.limit(ctx, 'aiProviderConfigListModels', {
			key: identity.subject,
		});
		if (!rl.ok) {
			return { supported: true, models: [], error: 'Too many requests — try again in a moment.' };
		}

		const row = await ctx.runQuery(internal.aiProviderConfig._getConfigRow, {});
		if (!row) return { supported: false, models: [] };

		if (args.plane === 'decision') return await listDecisionModels(ctx, row);

		const adapter = languageProviderFor(row.languageProviderKind);
		// Bind the optional method to a local so its narrowing survives the awaits
		// below (property narrowing on `adapter.listModels` would otherwise reset).
		const discover = adapter.listModels;
		if (!discover) return { supported: false, models: [] };

		try {
			const apiKey = adapter.isLocal ? undefined : storedLanguageKey(row);
			const baseUrl = row.languageBaseUrl ?? adapter.defaultBaseUrl;
			if (!baseUrl) {
				return { supported: true, models: [], error: 'This provider has no base URL configured.' };
			}
			// A hosted provider transmits the decrypted key to `baseUrl`, so it MUST
			// be https + public and the round trip goes through the SSRF guard
			// (DNS/connect-time private-range block + redirect refusal). A local,
			// keyless provider may target localhost, so it validates loosely and uses
			// a hardened plain fetch (no redirects, bounded). Either way the key never
			// reaches an unvalidated host.
			const requirePublic = !adapter.isLocal;
			const check = validateOutboundUrl(baseUrl, { requirePublic });
			if (!check.ok) {
				return { supported: true, models: [], error: `Base URL ${check.error}.` };
			}
			const fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = requirePublic
				? (input, init) => fetchGuarded(input, { ...init, protocols: ['https:'] })
				: (input, init) =>
						fetch(input, { ...init, redirect: 'manual', signal: AbortSignal.timeout(5000) });
			const models = await discover({ apiKey, baseUrl, fetchImpl });
			return { supported: true, models };
		} catch (e) {
			return {
				supported: true,
				models: [],
				error: e instanceof Error ? e.message : 'Could not load models.',
			};
		}
	},
});

/**
 * Decrypt a stored AES-256-GCM key envelope for `lib/llmProvider.resolveAiConfig`.
 * The ONLY call-time decryption point for the pluggable-provider resolver: the
 * v8-safe resolver can't touch `node:crypto`, so it hands the (already-read)
 * envelope columns to this Node action, which returns the plaintext key for
 * immediate model construction. Used for BOTH planes — the hosted language key
 * and the hosted-embedder key each flow through here. Internal-only — never
 * exposed to the client, and the caller who can invoke it already holds the
 * envelope from the row.
 */
export const _decryptSecretEnvelope = internalAction({
	args: {
		ciphertext: v.string(),
		iv: v.string(),
		authTag: v.string(),
		version: v.number(),
	},
	returns: v.string(),
	handler: async (_ctx, args): Promise<string> =>
		decryptSecret({
			ciphertext: args.ciphertext,
			iv: args.iv,
			authTag: args.authTag,
			version: args.version,
		}),
});
