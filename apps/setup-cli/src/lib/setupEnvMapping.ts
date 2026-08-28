/**
 * Config → `.env` mapping.
 *
 * The PURE half of the non-interactive setup path: it takes the validated
 * {@link SetupConfig} produced by `./setupConfig` and turns it into the exact
 * env the interactive wizard would have written — first the provider /
 * integration / domain / network patch the operator's answers imply, then the
 * deployment defaults that fill whatever the answers left absent.
 *
 * Kept next to `./setupConfig` rather than inside it so the schema + parse side
 * and the env side each stay readable; `buildSetupFromConfig` composes the two.
 * No secrets, no defaults for keys the operator set, no network validation.
 */

import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import type { EnvMap } from './env';
import { applyFreshFblDedupDefaults } from './fblDedupSetup';
import type { DeploymentMode, SetupConfig } from './setupConfig';

/**
 * Build the provider / integration / domain env patch from a config. Mirrors the
 * env keys produced by each step of the terminal wizard. Pure — no secrets, no
 * defaults, no network validation.
 */
export function buildEnvPatchFromConfig(config: SetupConfig): EnvMap {
	const patch: EnvMap = {};

	if (config.sending) {
		switch (config.sending.provider) {
			case 'mta':
				patch['EMAIL_PROVIDER'] = 'mta';
				break;
			case 'resend':
				patch['EMAIL_PROVIDER'] = 'resend';
				patch['RESEND_API_KEY'] = config.sending.apiKey;
				break;
			case 'emailit':
				patch['EMAIL_PROVIDER'] = 'emailit';
				patch['EMAILIT_API_KEY'] = config.sending.apiKey;
				break;
			case 'ses':
				patch['EMAIL_PROVIDER'] = 'ses';
				patch['AWS_SES_REGION'] = config.sending.region;
				patch['AWS_SES_ACCESS_KEY_ID'] = config.sending.accessKeyId;
				patch['AWS_SES_SECRET_ACCESS_KEY'] = config.sending.secretAccessKey;
				break;
			case 'smtp':
				// Port/TLS have safe backend defaults, so emit them only when set.
				patch['EMAIL_PROVIDER'] = 'smtp';
				patch['SMTP_RELAY_HOST'] = config.sending.host;
				patch['SMTP_RELAY_USERNAME'] = config.sending.username;
				patch['SMTP_RELAY_PASSWORD'] = config.sending.password;
				if (config.sending.port !== undefined) {
					patch['SMTP_RELAY_PORT'] = String(config.sending.port);
				}
				if (config.sending.secure !== undefined) {
					patch['SMTP_RELAY_SECURE'] = config.sending.secure ? 'true' : 'false';
				}
				break;
		}
	}

	if (config.ai) {
		switch (config.ai.provider) {
			case 'openrouter':
				patch['LLM_PROVIDER'] = 'openrouter';
				patch['LLM_API_KEY'] = config.ai.apiKey;
				patch['OPENROUTER_API_KEY'] = config.ai.apiKey;
				break;
			case 'openai':
				patch['LLM_PROVIDER'] = 'openai';
				patch['LLM_API_KEY'] = config.ai.apiKey;
				patch['OPENAI_API_KEY'] = config.ai.apiKey;
				break;
			case 'ollama':
				patch['LLM_PROVIDER'] = 'ollama';
				break;
			case 'custom':
				patch['LLM_PROVIDER'] = 'custom';
				patch['LLM_BASE_URL'] = config.ai.baseUrl;
				patch['LLM_API_KEY'] = config.ai.apiKey;
				patch['LLM_MODEL_FAST'] = config.ai.modelFast;
				patch['LLM_MODEL_CAPABLE'] = config.ai.modelCapable;
				break;
		}
	}

	if (config.integrations?.googleSafeBrowsingKey) {
		patch['GOOGLE_SAFE_BROWSING_API_KEY'] = config.integrations.googleSafeBrowsingKey;
	}
	if (config.integrations?.posthog) {
		patch['POSTHOG_API_KEY'] = config.integrations.posthog.apiKey;
		patch['POSTHOG_HOST'] = config.integrations.posthog.host;
		patch['NUXT_PUBLIC_POSTHOG_API_KEY'] = config.integrations.posthog.apiKey;
		patch['NUXT_PUBLIC_POSTHOG_HOST'] = config.integrations.posthog.host;
	}

	if (config.domain) {
		patch['EHLO_HOSTNAME'] = config.domain.ehloHostname;
		patch['RETURN_PATH_DOMAIN'] = config.domain.bounceDomain;
		// Wire the system/auth From-identity off the configured sending/EHLO
		// domain. Without these the Convex runtime never receives DEFAULT_FROM_*,
		// so system mail falls back to placeholders (noreply@mail.owlat.app /
		// noreply@example.com — auth/auth.ts, confirmationEmail.ts,
		// transactional/dispatch.ts). The EHLO hostname is the DKIM-signed sending
		// domain the MTA identifies as, so it is the correct From domain. Mirrors
		// the legacy bash wizard (scripts/setup.sh: DEFAULT_FROM_{DOMAIN,EMAIL,NAME}).
		patch['DEFAULT_FROM_DOMAIN'] = config.domain.ehloHostname;
		patch['DEFAULT_FROM_EMAIL'] = `noreply@${config.domain.ehloHostname}`;
		patch['DEFAULT_FROM_NAME'] = 'Owlat';
	}

	if (config.network) {
		// Set in the patch so `applySetupDefaults` (which only fills absent keys)
		// won't clobber them back to localhost. CONVEX_SITE_URL is the function
		// runtime's own site URL; the NUXT_PUBLIC_* values are what the web app
		// and the desktop client (via /api/instance-info) consume.
		patch['SITE_URL'] = config.network.siteUrl;
		patch['NUXT_PUBLIC_SITE_URL'] = config.network.siteUrl;
		patch['NUXT_PUBLIC_CONVEX_URL'] = config.network.convexUrl;
		patch['NUXT_PUBLIC_CONVEX_SITE_URL'] = config.network.convexSiteUrl;
		patch['CONVEX_SITE_URL'] = config.network.convexSiteUrl;
	}

	return patch;
}

/**
 * Fill in default deployment values for keys not already present (preserves an
 * operator's manual edits). Shared by the interactive wizard and the config
 * path so the two cannot diverge. CONVEX_SITE_URL points at the SITE proxy
 * (3211), where the http.route handlers are served; the cloud/sync port is 3210.
 */
export function applySetupDefaults(
	env: EnvMap,
	deploymentMode: DeploymentMode,
	flags?: Partial<Record<FeatureFlagKey, boolean>>,
	isFreshInstall = false
): void {
	const defaults: Record<string, string> = {
		SITE_URL: 'http://localhost:3000',
		CONVEX_SITE_URL: 'http://localhost:3211',
		NUXT_PUBLIC_SITE_URL: 'http://localhost:3000',
		NUXT_PUBLIC_CONVEX_URL: 'http://localhost:3210',
		NUXT_PUBLIC_CONVEX_SITE_URL: 'http://localhost:3211',
		// In-cluster MTA address. Every system/auth email (password reset,
		// invitations, double opt-in, account deletion) is sent through the
		// instance MTA regardless of EMAIL_PROVIDER, and the Convex function
		// runtime reads MTA_API_URL from the pushed deployment env — so it must be
		// set for resend/ses installs too, not only EMAIL_PROVIDER=mta. Without it
		// `selectRuntimeEnvVars` drops the empty key and the backend can send no
		// mail (mtaSendProvider fails with AUTH_FAILED — "MTA_API_URL … is not set").
		// MTA_INTERNAL_URL is the in-cluster address the delivery/scan client
		// (mail/mtaClient.ts) prefers; both point at the same docker service.
		// Matches the legacy bash wizard (scripts/setup.sh: http://mta:3100).
		MTA_API_URL: 'http://mta:3100',
		MTA_INTERNAL_URL: 'http://mta:3100',
		SMTP_OUTCOME_JOURNAL_MAX_SIZE: '10000',
		// Native outbound IPv6 is an earned upgrade configured after the IPv4
		// identity, routed source, PTR/AAAA, and SPF checks are green.
		MTA_IPV6_ENABLED: 'false',
		// Dev endpoints (/seed/demo, /dev/reset) are fail-closed unless truthy.
		// Default ON for local 'dev' installs; production self-host stays closed
		// (quickstart flips it on only when demo-seeding).
		OWLAT_DEV_MODE: deploymentMode === 'dev' ? 'true' : 'false',
	};
	if (isFreshInstall) {
		applyFreshFblDedupDefaults(defaults);
		// NEW-DEPLOYMENT-ONLY: require a verified email before a signup/invitation
		// can sign in (BetterAuth requireEmailVerification + sendOnSignUp + the org
		// plugin's requireEmailVerificationOnInvitation — apps/api/convex/auth/auth.ts).
		// Gated on `isFreshInstall` so re-running setup on an EXISTING install never
		// flips it on and locks out legacy users who have no verified flag. It is
		// pushed into the Convex function runtime (convexRuntimeEnv), and every
		// deployment here has MTA_API_URL wired above so the verification link can be
		// delivered. A stranded user is recoverable by an owner/admin via the
		// mark-verified / resend-verification actions (auth/emailVerificationAdmin.ts).
		defaults['REQUIRE_EMAIL_VERIFICATION'] = 'true';
	}
	// External-mailbox feature (apps/mail-sync worker, mail.external flag): the
	// Convex function runtime dispatches outbound mail for external IMAP/SMTP
	// accounts to the worker at MAIL_SYNC_API_URL. Without it `selectRuntimeEnvVars`
	// drops the empty key, `getOptional('MAIL_SYNC_API_URL')` is undefined, and
	// mail/outbound.ts saves the message to Sent but never dispatches it. The worker
	// listens on MAIL_SYNC_PORT=3200 (docker-compose.yml); the matching
	// MAIL_SYNC_API_KEY is generated in ensureSecrets. Only defaulted when the
	// feature is on so a non-postbox install doesn't push a dangling URL.
	if (flags?.['mail.external']) {
		defaults['MAIL_SYNC_API_URL'] = 'http://mail-sync:3200';
	}
	for (const [key, value] of Object.entries(defaults)) {
		if (env[key] === undefined || env[key] === '') env[key] = value;
	}
}
