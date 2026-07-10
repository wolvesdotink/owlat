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
 *                             URL (local). Rate-limited. Returns `{ ok, error }`.
 */

import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { authedAction } from './lib/authedFunctions';
import { decryptSecret, encryptSecret } from './lib/credentialCrypto';
import { languageProviderFor } from './lib/llmProviders';
import { rateLimiter } from './rateLimiter';
import { throwUnauthenticated } from './_utils/errors';
import {
	embeddingProviderKindValidator,
	languageProviderKindValidator,
} from './lib/aiProviderConfigValidators';

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

		const embeddingProviderKind = args.embeddingProviderKind ?? 'local';
		const isEmbeddingLocal = embeddingProviderKind === 'local';

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
		});
	},
});

/**
 * Test the stored language provider. For a hosted provider it decrypts the key
 * and runs the adapter's `validateCredentials`; for a local provider it probes
 * the base URL for reachability. Persists nothing, returns only `{ ok, error }`
 * (never the key). Rate-limited per user.
 */
// all-members: read-only reachability/credential probe. Persists nothing and
// returns only { ok, error } — never the key — so any member may run it.
export const testConnection = authedAction({
	args: {},
	handler: async (ctx): Promise<{ ok: boolean; error?: string }> => {
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

		const adapter = languageProviderFor(row.languageProviderKind);
		try {
			if (adapter.isLocal) {
				const baseUrl = row.languageBaseUrl ?? adapter.defaultBaseUrl;
				if (!baseUrl) {
					return { ok: false, error: 'This local provider has no base URL configured.' };
				}
				// Any HTTP response (even a 404) proves the endpoint is reachable.
				await fetch(baseUrl, { method: 'GET', signal: AbortSignal.timeout(5000) });
				return { ok: true };
			}
			const apiKey =
				row.secretCiphertext !== undefined &&
				row.secretIv !== undefined &&
				row.secretAuthTag !== undefined &&
				row.secretEnvelopeVersion !== undefined
					? decryptSecret({
							ciphertext: row.secretCiphertext,
							iv: row.secretIv,
							authTag: row.secretAuthTag,
							version: row.secretEnvelopeVersion,
						})
					: undefined;
			adapter.validateCredentials({ apiKey, baseUrl: row.languageBaseUrl });
			return { ok: true };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : 'Connection test failed.' };
		}
	},
});
