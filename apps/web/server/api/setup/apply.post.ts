/**
 * POST /api/setup/apply
 *
 * The wizard's final step. Creates the first admin user + singleton org via the
 * Convex seed endpoint, then writes the .env file, the docker-compose override
 * for the chosen feature profiles, and the CLI-side flag store.
 *
 * Provisioning happens BEFORE any file is written so that a failure leaves the
 * instance in setup mode and the wizard retryable. Callable only when
 * OWLAT_SETUP_MODE=true AND the caller echoes the one-time setup token in the
 * X-Setup-Token header (see server/utils/setupToken.ts); on success the .env
 * flips OWLAT_SETUP_MODE=false so a restart drops the setup-mode middleware.
 */

import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
	getActiveProfiles,
	isDeliveryProviderKind,
	needsDeliveryProvider,
	resolveFlags,
	type FeatureFlagState,
} from '@owlat/shared/featureFlags';
import { readEnvFile, writeEnvFile } from '@owlat/shared/setupEnv';
import { ensureSecrets } from '@owlat/shared/setupSecrets';
import { hashPassword } from '@owlat/shared/passwordHash';
import {
	deriveConvexAdminUrl,
	pushConvexRuntimeEnv,
	selectRuntimeEnvVars,
} from '@owlat/shared/convexRuntimeEnv';

interface ApplyBody {
	flags: FeatureFlagState;
	env: Record<string, string>;
	admin: { email: string; name: string; password: string };
	/** "Moving from another platform?" — persisted to instanceSettings.isMigrationMode. */
	isMigrationMode?: boolean;
}

const OWLAT_DIR = process.env['OWLAT_DIR'] || '/opt/owlat';

export default defineEventHandler(
	async (event): Promise<{ ok: boolean; message?: string; redirectTo?: string }> => {
		if (process.env['OWLAT_SETUP_MODE'] !== 'true') {
			throw createError({ statusCode: 403, message: 'Setup mode is not active.' });
		}
		// Setup mode is a precondition, not authorization: require the one-time
		// setup token so only the operator who ran `owlat setup` can seed the admin
		// and rewrite .env. Missing/wrong token -> 401.
		requireSetupToken(event);

		const body = await readBody<ApplyBody>(event);
		if (!body?.flags || !body?.admin?.email) {
			throw createError({ statusCode: 400, message: 'flags, env, and admin are required.' });
		}

		if (!/^.+@.+\..+$/.test(body.admin.email)) {
			return { ok: false, message: 'Invalid admin email.' };
		}
		if (body.admin.password.length < 12) {
			return { ok: false, message: 'Admin password must be at least 12 characters.' };
		}

		// Migration mode never promises an import the instance cannot perform: the
		// import surface reads the `mail.external` flag, so when the operator says they
		// are moving from another platform, align the plumbing by enabling it before
		// the cascade resolves. A fresh-start install leaves the flag untouched.
		const isMigrationMode = body.isMigrationMode === true;
		const flags = isMigrationMode ? { ...body.flags, 'mail.external': true } : body.flags;

		// Resolve dependency cascade so we never persist an inconsistent flag set.
		const resolved = resolveFlags(flags);

		// Authoritative floor for the "sending needs a delivery provider" invariant.
		// The client gates this too, but the server must refuse to persist a config
		// where bulk sending is on without a REAL provider (otherwise every send
		// would fail at dispatch). Require a known delivery-provider kind, not just a
		// truthy value — an external IMAP mailbox is not a delivery provider.
		const chosenProvider = body.env?.['EMAIL_PROVIDER'];
		const hasRealProvider = isDeliveryProviderKind(chosenProvider);
		if (needsDeliveryProvider(resolved) && !hasRealProvider) {
			return {
				ok: false,
				message:
					'Campaigns, transactional, or automations are enabled but no delivery provider is configured. Choose MTA, Resend, SES, or an SMTP relay, or disable bulk sending.',
			};
		}

		// The built-in MTA is opt-in: it runs only when it is the delivery provider
		// or when postbox/inbox need it, so pass the chosen provider through.
		const profiles = getActiveProfiles(flags, {
			deliveryProvider: body.env?.['EMAIL_PROVIDER'],
		});

		// 1. Compute the merged env in memory (idempotent secret generation). The
		//    INSTANCE_SECRET is preserved from the existing .env, so it matches the
		//    value the backend container was started with — that is what authenticates
		//    the seed call below. Nothing is persisted yet.
		const envPath = resolve(OWLAT_DIR, '.env');
		const existing = await readEnvFile(envPath);
		const merged: Record<string, string> = ensureSecrets({ ...existing, ...body.env });
		for (const [key, value] of Object.entries({
			SITE_URL: 'http://localhost:3000',
			CONVEX_SITE_URL: 'http://localhost:3211',
			NUXT_PUBLIC_SITE_URL: 'http://localhost:3000',
			NUXT_PUBLIC_CONVEX_URL: 'http://localhost:3210',
			NUXT_PUBLIC_CONVEX_SITE_URL: 'http://localhost:3211',
			// In-cluster MTA address — pushed into the Convex runtime below. ALL
			// system/auth mail (password reset, invitations, double opt-in) routes
			// through the instance MTA regardless of EMAIL_PROVIDER, so this must be
			// present even for a resend/ses wizard install; otherwise
			// selectRuntimeEnvVars drops the empty key and the backend can send no
			// mail. Mirrors the setup-cli applySetupDefaults (http://mta:3100).
			MTA_API_URL: 'http://mta:3100',
			MTA_INTERNAL_URL: 'http://mta:3100',
			OWLAT_DEV_MODE: 'false',
		})) {
			if (!merged[key]) merged[key] = value;
		}
		// Wire the system/auth From-identity off the configured sending/EHLO domain
		// when one is present, so system mail isn't sent from the placeholder
		// noreply@mail.owlat.app. Only fills absent keys — never clobbers a value the
		// operator supplied. Mirrors buildEnvPatchFromConfig in the setup-cli path.
		const ehloHostname = merged['EHLO_HOSTNAME'];
		if (ehloHostname) {
			if (!merged['DEFAULT_FROM_DOMAIN']) merged['DEFAULT_FROM_DOMAIN'] = ehloHostname;
			if (!merged['DEFAULT_FROM_EMAIL']) merged['DEFAULT_FROM_EMAIL'] = `noreply@${ehloHostname}`;
			if (!merged['DEFAULT_FROM_NAME']) merged['DEFAULT_FROM_NAME'] = 'Owlat';
		}

		// 2. Create the admin user + org via the Convex seed endpoint (mirrors the
		//    setup-cli `bootstrap-org` flow: scrypt-hash the password into BetterAuth's
		//    format, then POST /seed/admin with the shared X-Instance-Secret). 201 =
		//    created, 409 = already exists (idempotent) — both let the operator sign in.
		const instanceSecret = merged['INSTANCE_SECRET'];
		if (!instanceSecret) {
			return { ok: false, message: 'INSTANCE_SECRET is missing; cannot create the admin account.' };
		}
		const convexSiteUrl = (
			process.env['CONVEX_SITE_URL'] ||
			process.env['NUXT_PUBLIC_CONVEX_SITE_URL'] ||
			merged['CONVEX_SITE_URL'] ||
			'http://localhost:3211'
		).replace(/\/+$/, '');

		const passwordHash = await hashPassword(body.admin.password);
		let seedStatus: number;
		let seedError: string | undefined;
		try {
			const seedRes = await fetch(`${convexSiteUrl}/seed/admin`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Instance-Secret': instanceSecret },
				body: JSON.stringify({
					email: body.admin.email,
					name: body.admin.name,
					passwordHash,
					flags: resolved,
					isMigrationMode,
				}),
			});
			seedStatus = seedRes.status;
			if (seedStatus !== 201 && seedStatus !== 409) {
				seedError = await seedRes
					.json()
					.then((j: { error?: string }) => j?.error)
					.catch(() => undefined);
			}
		} catch (e) {
			return {
				ok: false,
				message: `Could not reach the backend at ${convexSiteUrl} to create the admin account. Is the stack healthy? (${(e as Error).message})`,
			};
		}

		if (seedStatus === 401) {
			return {
				ok: false,
				message:
					'The backend rejected the admin bootstrap (INSTANCE_SECRET mismatch). Ensure the web app and backend share the same INSTANCE_SECRET, then retry.',
			};
		}
		if (seedStatus !== 201 && seedStatus !== 409) {
			return {
				ok: false,
				message: `Admin account creation failed: ${seedError ?? `status ${seedStatus}`}.`,
			};
		}

		// 2b. Push the function-runtime env vars (the operator's EMAIL_PROVIDER +
		//     RESEND_API_KEY / AWS_SES_* and the other CONVEX_RUNTIME_ENV_KEYS) INTO
		//     the Convex deployment. Convex functions read these from the deployment's
		//     env store, NOT from this container's `.env` — writing `.env` alone is a
		//     no-op for sending, so the provider choice would otherwise never take
		//     effect. This is the HTTP equivalent of the CLI's `convex env set` step
		//     (apps/setup-cli/src/lib/convexDeploy.ts). Done before persisting `.env`
		//     and dropping setup mode so a failure leaves the wizard retryable.
		//
		//     The admin key is read from the merged `.env` (written there by the
		//     deploy step that minted it); the admin API lives on the cloud port,
		//     derived from the site-proxy URL used for the seed call above.
		const convexAdminKey = merged['CONVEX_ADMIN_KEY'];
		if (!convexAdminKey) {
			return {
				ok: false,
				message:
					'CONVEX_ADMIN_KEY is missing from .env, so the email provider and other runtime settings cannot be pushed into the Convex backend. Run the deploy step (which mints the admin key) and retry.',
			};
		}
		const convexAdminUrl = deriveConvexAdminUrl(convexSiteUrl);
		const runtimeVars = selectRuntimeEnvVars(merged);
		try {
			await pushConvexRuntimeEnv(convexAdminUrl, convexAdminKey, runtimeVars);
		} catch (e) {
			return {
				ok: false,
				message: `Could not push runtime settings (email provider, credentials) into the Convex backend: ${(e as Error).message}`,
			};
		}

		// 3. Provisioning succeeded — persist config and drop setup mode so a restart
		//    removes the setup-mode middleware.
		merged['OWLAT_SETUP_MODE'] = 'false';
		// Canonicalize COMPOSE_PROFILES in .env so the updater sidecar and a bare
		// `docker compose up` activate the same services the override marker declares
		// (the built-in MTA is now an opt-in profile).
		merged['COMPOSE_PROFILES'] = profiles.join(',');
		await writeEnvFile(envPath, merged);

		const overridePath = resolve(OWLAT_DIR, 'docker-compose.override.yml');
		const overrideYaml =
			`# Generated by Owlat setup wizard. DO NOT EDIT MANUALLY.\n` +
			`# Active profiles: ${profiles.join(', ') || '(none)'}\n` +
			`x-owlat-profiles: [${profiles.join(', ')}]\n` +
			`x-owlat-generated-at: '${new Date().toISOString()}'\n` +
			`services: {}\n`;
		await writeFile(overridePath, overrideYaml);

		// Mirror the resolved flags to .owlat-flags.json — the canonical CLI-side flag
		// store that `owlat doctor` / `feature` / `pack` read. Without it they
		// recompute from defaults and silently drop the wizard's selections.
		const flagStatePath = resolve(OWLAT_DIR, '.owlat-flags.json');
		await writeFile(flagStatePath, JSON.stringify(resolved, null, 2), { mode: 0o600 });

		// A 409 means an admin already existed (a prior attempt seeded one). The
		// just-entered email may differ from that admin's, so don't prefill it into
		// the login form — send the operator to a blank login with an explanatory note.
		if (seedStatus === 409) {
			return {
				ok: true,
				message: 'An admin account already exists — sign in with the original credentials.',
				redirectTo: `/auth/login?postSetup=1`,
			};
		}

		return {
			ok: true,
			message: `Setup applied. Active profiles: ${profiles.join(', ') || '(none)'}.`,
			redirectTo: `/auth/login?postSetup=1&email=${encodeURIComponent(body.admin.email)}`,
		};
	}
);
