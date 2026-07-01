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
 * `pushConvexRuntimeEnv` half uses `fetch` and is intended for server code; keep
 * it out of the browser-safe `.` barrel.
 */

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
	'MTA_WEBHOOK_SECRET',
	'MTA_IP_POOLS',
	'MTA_RETURN_PATH_DOMAIN',
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
	// LLM
	'LLM_PROVIDER',
	'LLM_API_KEY',
	'LLM_BASE_URL',
	'LLM_MODEL',
	'LLM_MODEL_FAST',
	'LLM_MODEL_CAPABLE',
	'LLM_EMBEDDING_MODEL',
	'LLM_COMPLEXITY_ROUTING',
	'OPENAI_API_KEY',
	'OPENROUTER_API_KEY',
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
] as const;

/**
 * From a `.env` map, pick the function-runtime vars that have a value. Compose-
 * only vars (ports, image versions, `NUXT_PUBLIC_*`, `REDIS_*`) are excluded —
 * they never belong in the Convex deployment.
 */
export function selectRuntimeEnvVars(env: Record<string, string>): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	for (const key of CONVEX_RUNTIME_ENV_KEYS) {
		const value = env[key];
		if (value !== undefined && value !== '') out.push([key, value]);
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
	fetchImpl: typeof fetch = fetch,
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
			`Could not reach the Convex admin API at ${base} to set runtime env vars: ${(e as Error).message}`,
		);
	}
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(
			`Convex admin API rejected the runtime env update (status ${res.status})${detail ? `: ${detail}` : ''}.`,
		);
	}
}
