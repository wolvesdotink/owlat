/**
 * Default deployment values for keys the operator did not set.
 *
 * Split out of `setupConfig.ts` to keep that file under the ~500 LOC ratchet
 * (CONVENTIONS.md). The provider-kind mapping deliberately stayed in
 * `setupConfig.ts`: it is the site the provider-identity allowlist licenses.
 */

import type { EnvMap } from './env';
import type { DeploymentMode } from './setupConfig';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import { applyFreshFblDedupDefaults } from './fblDedupSetup';

/**
 * The decision adapter a BRAND-NEW install's wizard pre-fills — "what we
 * recommend", and nothing more. Deliberately not the backend's
 * `DEFAULT_DECISION_KIND` ('llm'), which is what an install that never opted in
 * RESOLVES to: one name for both would turn a recommendation into a migration.
 * Nothing is written to `.env` unless the operator supplies a key of their own.
 */
export const SETUP_DEFAULT_DECISION_KIND = 'typesafe';

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
	// Decision plane (the third AI plane, ADR-0060). Resolution consults
	// DECISION_PROVIDER only when the stored config names no adapter, and an
	// unset value means the language-backed one — so a deployment carrying a
	// TypeSafe key and nothing naming the adapter holds a credential it never
	// uses, which reads as "the provider is broken" rather than "nothing was
	// selected". A key present with no adapter named is therefore read as the
	// one intent it can have.
	//
	// Nothing is defaulted WITHOUT a key: an install that never entered one
	// writes neither variable and answers every judgement on its language model,
	// exactly as it did before this plane existed. The `ai.decisionPlane` flag
	// still has to be on, and an adapter stored on the AI-provider page still
	// wins over both.
	if (env['TYPESAFE_API_KEY']) {
		defaults['DECISION_PROVIDER'] = 'typesafe';
	}
	for (const [key, value] of Object.entries(defaults)) {
		if (env[key] === undefined || env[key] === '') env[key] = value;
	}
}
