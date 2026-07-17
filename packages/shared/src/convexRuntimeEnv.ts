/**
 * Convex function-runtime environment variables — single source of truth + the
 * HTTP push that gets them INTO a self-hosted Convex deployment.
 *
 * Why this module exists: a self-hosted Convex backend reads function config
 * from the DEPLOYMENT's env store (populated by `convex env set`), NOT from the
 * compose `.env` that configures the container processes. So writing `.env` is
 * not enough — the runtime keys must be pushed into the backend separately.
 *
 * Two callers must agree on WHICH keys are runtime keys and HOW to push them:
 *   • the `owlat-setup` CLI (`apps/setup-cli`), which pushes via the
 *     `convex-deploy` container running `convex env set`; and
 *   • the web setup wizard (`apps/web/server/api/setup/apply.post.ts`), which
 *     runs in a read-only container with no Docker socket and so pushes over
 *     HTTP to the backend's admin API instead.
 *
 * `CONVEX_RUNTIME_ENV_KEYS` is the shared list (kept in sync with the `EnvKey`
 * union in `apps/api/convex/lib/env.ts` by `check-env-keys-sync.sh`).
 * `pushConvexRuntimeEnv` is the HTTP equivalent of `convex env set`, usable from
 * any Node context that has the deployment URL + admin key.
 *
 * Exposed via the `@owlat/shared/convexRuntimeEnv` subpath ONLY — the
 * `pushConvexRuntimeEnv` half uses `fetch`, and `selectRuntimeEnvVars` pulls in
 * `node:crypto` (via `envBackupBox`) to unseal secrets sealed at rest in the
 * `.env` backup copy — both are intended for server code; keep this module out
 * of the browser-safe `.` barrel.
 */

import { createEnvBackupBox, isEnvBackupSealedValue, type EnvBackupBox } from './envBackupBox';

/**
 * Function-runtime env keys — the single source of truth is the `EnvKey` union
 * in `apps/api/convex/lib/env.ts`. These are read by Convex functions via
 * `lib/env.ts`, so they must be pushed into the backend (with `convex env set`
 * or the admin API) rather than left in the compose `.env` (which only
 * configures the container processes — convex, mta, web — not the Convex
 * function sandbox).
 *
 * Keep this list in sync with `apps/api/convex/lib/env.ts`. The
 * `check-env-keys-sync.sh` lint guard (run as part of the setup-cli `lint`
 * script) asserts that, failing the build if a new `EnvKey` is added here
 * without being pushed — or vice versa.
 */
export const CONVEX_RUNTIME_ENV_KEYS = [
	// Auth & instance
	'BETTER_AUTH_SECRET',
	'INSTANCE_SECRET',
	// The PREVIOUS INSTANCE_SECRET — set ONLY during a secret-rotation window
	// (Sealed Mail key lifecycle, E6). Pushed into the deployment so the E2EE key
	// box's mixed-vault fallback (open under current, else previous) actually
	// reaches the Convex function runtime while the re-seal migration runs; a
	// self-hoster who set it only in the compose .env would otherwise find the
	// fallback silently dead and old-secret rows unopenable mid-migration.
	'INSTANCE_SECRET_PREVIOUS',
	'OWLAT_VERSION',
	'OWLAT_DEV_MODE',
	// Site URLs
	'SITE_URL',
	'ADMIN_SITE_URL',
	// NOT 'CONVEX_SITE_URL': it is a Convex BUILT-IN — the backend derives it
	// from CONVEX_SITE_ORIGIN (set on the convex container from .env) and
	// `convex env set` rejects overriding it (EnvVarNameForbidden).
	'CONTROL_PLANE_URL',
	'ALLOWED_ORIGINS',
	// Email defaults
	'EMAIL_PROVIDER',
	'DEFAULT_FROM_DOMAIN',
	'DEFAULT_FROM_EMAIL',
	'DEFAULT_FROM_NAME',
	// MTA
	'MTA_API_KEY',
	'MTA_API_URL',
	'MTA_INTERNAL_URL',
	// The MTA's public EHLO/MX hostname — pushed so the backend can surface it
	// as the inbound MX target in the admin "Receiving" DNS panel.
	'EHLO_HOSTNAME',
	'MTA_SPF_INCLUDE',
	'MTA_DMARC_RUA',
	'MTA_TLSRPT_RUA',
	// Outbound TLS floor (opportunistic | require | require-verified) — pushed so
	// the backend can surface the current mode in the transport editor and avoid a
	// silent TLS-policy downgrade when an admin re-applies the transport.
	'OUTBOUND_TLS_MODE',
	'MTA_WEBHOOK_SECRET',
	'MTA_IP_POOLS',
	'MTA_RETURN_PATH_DOMAIN',
	// The active transport's effective DKIM d= domain, when it isn't the per-message
	// From-domain. Read by the outbound DMARC-alignment guard at Convex function
	// runtime (delivery status + campaign From-picker), so it must be pushed.
	'OUTBOUND_DKIM_DOMAIN',
	'SPF_QUALIFIER',
	// Mail sync worker
	'MAIL_SYNC_API_URL',
	'MAIL_SYNC_API_KEY',
	// Provider: Resend
	'RESEND_API_KEY',
	'RESEND_WEBHOOK_SECRET',
	// Provider: AWS SES
	'AWS_SES_ACCESS_KEY_ID',
	'AWS_SES_REGION',
	'AWS_SES_SECRET_ACCESS_KEY',
	'SES_CONFIGURATION_SET',
	'SES_SNS_TOPIC_ARN',
	// Provider: generic SMTP relay (Mailgun/Postmark/SendGrid/Brevo/custom).
	// The instance-level outbound transport when EMAIL_PROVIDER=smtp — the
	// in-house SMTP relay adapter reads these at Convex function runtime, so they
	// must be pushed into the deployment (not just left in the compose .env) or a
	// relay configured via setup could never send.
	'SMTP_RELAY_HOST',
	'SMTP_RELAY_PORT',
	'SMTP_RELAY_SECURE',
	'SMTP_RELAY_USERNAME',
	'SMTP_RELAY_PASSWORD',
	// LLM
	'LLM_PROVIDER',
	'LLM_API_KEY',
	'LLM_BASE_URL',
	'LLM_MODEL',
	'LLM_MODEL_FAST',
	'LLM_MODEL_CAPABLE',
	'LLM_EMBEDDING_MODEL',
	// Local-by-default embedding plane (an OpenAI-compatible sidecar, e.g. Ollama).
	// Read at Convex function runtime by resolveEmbeddingModel via getOptional(), so
	// they must be pushed into the deployment — a self-hoster who sets
	// LOCAL_EMBEDDING_BASE_URL in .env would otherwise find it silently never applied
	// and the local embedder falls back to the adapter default (http://localhost:11434/v1,
	// unreachable from the Convex container), i.e. the local-by-default plane silently
	// doesn't work.
	'LOCAL_EMBEDDING_BASE_URL',
	'LOCAL_EMBEDDING_MODEL',
	'LLM_COMPLEXITY_ROUTING',
	'OPENAI_API_KEY',
	'OPENROUTER_API_KEY',
	// Per-org dollar-spend budget for LLM calls (analytics/spendBudget.ts).
	// Pushed into the deployment so resolveBudgetConfig() reads real ceilings
	// at function runtime; without these the gate reads the '0' default and the
	// budget is never enforced (fail-OPEN on spend).
	'AI_SPEND_DAILY_BUDGET_USD',
	'AI_SPEND_MONTHLY_BUDGET_USD',
	'AI_SPEND_WARN_FRACTION',
	'AI_SPEND_ADVISORY_RESERVE_FRACTION',
	// Analytics & links
	'POSTHOG_API_KEY',
	'POSTHOG_HOST',
	'UNSUBSCRIBE_SECRET',
	// Security
	'GOOGLE_SAFE_BROWSING_API_KEY',
	// Rate-limit client-IP trust mode. Without this, the Convex runtime never
	// receives RATE_LIMIT_TRUSTED_PROXY, getClientIp() returns 'unknown' for
	// every caller, and the public rate-limit buckets collapse to coarse shared
	// keys — so an operator who sets it in .env would still get no per-IP keying.
	'RATE_LIMIT_TRUSTED_PROXY',
	// Inbound channel webhooks
	'TWILIO_AUTH_TOKEN',
	'META_APP_SECRET',
	'META_VERIFY_TOKEN',
	'GENERIC_WEBHOOK_SECRET',
	// Code-work / GitHub PR merge webhook
	'GITHUB_WEBHOOK_SECRET',
	// Calendar / availability grounding for scheduling replies (mail/availability.ts).
	// Read at Convex function runtime by fetchOpenSlots via getOptional(), so they
	// must be pushed into the deployment — without them a self-hoster who sets them
	// in .env would find them silently never applied and availability grounding stays
	// off. Optional read-only ICS/CalDAV URL for the owner's own calendar + the IANA
	// timezone used to label open slots. Unset ⇒ exactly today's sender-phrase-only
	// scheduling replies.
	'CALENDAR_FREEBUSY_ICS_URL',
	'CALENDAR_TIMEZONE',
] as const;

/**
 * From a `.env` map, pick the function-runtime vars that have a value. Compose-
 * only vars (ports, image versions, `NUXT_PUBLIC_*`, `REDIS_*`) are excluded —
 * they never belong in the Convex deployment.
 *
 * This is also the deploy-time RESEED step for secrets sealed at rest in the
 * `.env` backup copy (see `envBackupBox.ts`): a value carrying the
 * `envsealed:v1:` prefix is unsealed with the map's own INSTANCE_SECRET before
 * being pushed, so the live deployment env store always receives the WORKING
 * plaintext credential. Plain values pass through untouched — a legacy
 * plaintext `.env` keeps deploying exactly as before.
 *
 * FAIL CLOSED: a sealed token that cannot be opened (tampered, or the
 * INSTANCE_SECRET it was sealed under is gone) throws a clear error naming the
 * key — ciphertext must never be pushed as a live credential, where it would
 * silently break the path that reads it (e.g. SMTP relay auth).
 */
export function selectRuntimeEnvVars(env: Record<string, string>): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	let box: EnvBackupBox | null = null;
	for (const key of CONVEX_RUNTIME_ENV_KEYS) {
		const value = env[key];
		if (value === undefined || value === '') continue;
		if (!isEnvBackupSealedValue(value)) {
			out.push([key, value]);
			continue;
		}
		const instanceSecret = env['INSTANCE_SECRET'];
		if (!instanceSecret) {
			throw new Error(
				`Refusing to push ${key}: its .env value is sealed (envsealed:v1:…) but INSTANCE_SECRET is missing from the same .env, so it cannot be unsealed. Restore INSTANCE_SECRET or re-enter the credential.`
			);
		}
		box ??= createEnvBackupBox(instanceSecret);
		let plaintext: string;
		try {
			plaintext = box.open(value);
		} catch (e) {
			throw new Error(
				`Refusing to push ${key}: its sealed .env value could not be opened (${(e as Error).message}). The token is tampered/corrupt or was sealed under a different INSTANCE_SECRET — re-enter the credential rather than deploying ciphertext as the live value.`
			);
		}
		out.push([key, plaintext]);
	}
	return out;
}

/**
 * Derive the Convex backend's admin/cloud-port URL (where the admin API lives)
 * from the site-proxy URL the web tier already uses to reach the HTTP routes.
 *
 * Self-hosted Convex serves the sync/admin API on one port (3210) and the HTTP
 * routes (`/seed/admin`, …) on the site-proxy port (3211). The setup endpoint
 * holds the site-proxy URL (`CONVEX_SITE_URL`, e.g. `http://convex:3211`); the
 * admin API is the same host on the cloud port, so we swap a trailing `:3211`
 * for `:3210`. If the URL doesn't carry the site-proxy port we return it as-is.
 */
export function deriveConvexAdminUrl(siteUrl: string): string {
	const trimmed = siteUrl.replace(/\/+$/, '');
	return trimmed.replace(/:3211(?=$|\/)/, ':3210');
}

/**
 * Push function-runtime env vars into a self-hosted Convex deployment over HTTP
 * — the equivalent of `convex env set`, for callers that can't shell out to the
 * Convex CLI (e.g. the read-only web container running the setup wizard).
 *
 * Hits the deployment's admin API `POST /api/update_environment_variables`
 * (authenticated with `Authorization: Convex <adminKey>`), the same endpoint the
 * Convex CLI uses under the hood. Values are sent in the request body, never
 * interpolated into a shell, so secrets need no escaping. A single request sets
 * every var. No-ops when `vars` is empty.
 *
 * Throws on a non-2xx response or a network failure so the caller can surface a
 * clear error and keep the instance retryable.
 */
export async function pushConvexRuntimeEnv(
	adminUrl: string,
	adminKey: string,
	vars: Array<[string, string]>,
	fetchImpl: typeof fetch = fetch
): Promise<void> {
	if (vars.length === 0) return;
	const base = adminUrl.replace(/\/+$/, '');
	const changes = vars.map(([name, value]) => ({ name, value }));
	let res: Response;
	try {
		res = await fetchImpl(`${base}/api/update_environment_variables`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Convex ${adminKey}`,
			},
			body: JSON.stringify({ changes }),
		});
	} catch (e) {
		throw new Error(
			`Could not reach the Convex admin API at ${base} to set runtime env vars: ${(e as Error).message}`
		);
	}
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(
			`Convex admin API rejected the runtime env update (status ${res.status})${detail ? `: ${detail}` : ''}.`
		);
	}
}
