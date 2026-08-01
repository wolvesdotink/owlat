/**
 * POST /api/delivery/apply-transport
 *
 * Change the delivery transport on a RUNNING instance without hand-editing
 * `.env` — the in-app twin of the setup wizard's apply step, scoped to just the
 * sending transport. Gated on the `organization:manage` floor (`requireOrgAdmin`).
 *
 * The client sends the provider-key patch it built with the wizard's own
 * `buildProviderEnv` (so the editor and the wizard produce byte-identical env),
 * containing ONLY the keys that should be SET. This endpoint:
 *
 *   1. Rejects any key outside `PROVIDER_ENV_KEYS` — a transport change can
 *      never inject an unrelated env var (e.g. `INSTANCE_SECRET`).
 *   2. Pushes the change into the Convex deployment's env store (the live source
 *      the send path reads via `getOptional`), setting supplied CREDENTIALS and
 *      CLEARING dropped ones — so flipping provider leaves no stale credential
 *      live — while PRESERVING the From-identity keys the patch omits (a blank
 *      From field means "keep the current default", never "clear it"). This takes
 *      effect immediately; no restart is needed for sends to switch.
 *   3. Persists the same patch to `.env` (mode preserved by `writeEnvFile`) so
 *      the choice survives a container recreate — with the SMTP relay password
 *      SEALED (never plaintext) in that backup copy.
 *
 * Secret hygiene: credentials arrive from the admin's own form and are written
 * to the encrypted deployment env store + the `.env` file (0600). The SMTP
 * relay password is SEALED in the `.env` backup copy (AES-256-GCM under
 * INSTANCE_SECRET, `@owlat/shared/envBackupBox`) — the live env store receives
 * the working plaintext, and the deploy-time reseed (`selectRuntimeEnvVars`)
 * unseals the backup before any re-push, so a `.env` dump never leaks the relay
 * password. No credential VALUE is ever returned — the response carries only
 * booleans and human copy.
 *
 * When the deployment can't be reached to push live (no `CONVEX_ADMIN_KEY` on
 * disk, e.g. a dev checkout), the `.env` is still written and the response says
 * plainly that a restart is required — the caller hands off to the restart
 * affordance rather than failing silently.
 *
 * DISCONNECTING THE RELAY GOES THROUGH HERE TOO, and it is the one transport
 * change that can lose reputation: cells the ramp has not graduated are still
 * sending part of their mail through the relay, and repointing at the built-in
 * MTA moves all of that traffic at once — the exact failure the ramp exists to
 * avoid. So the typed phrase is re-checked HERE, on the server, exactly as
 * `forceAdvanceCellShare` re-checks its own: a client that skipped the
 * consequence dialog, a replayed request and a script all meet the same rule.
 */

import { resolve } from 'node:path';
import {
	planTransportEnvChange,
	UnexpectedTransportEnvKeyError,
	type TransportEnvPlan,
} from '@owlat/shared/setupSendingPresets';
import { isDeliveryProviderKind } from '@owlat/shared/featureFlags';
import { readEnvFile, writeEnvFile } from '@owlat/shared/setupEnv';
import { deriveConvexAdminUrl, pushConvexRuntimeEnv } from '@owlat/shared/convexRuntimeEnv';
import { sealRelayPasswordForBackup } from '@owlat/shared/envBackupBox';
import {
	isConfirmationPhraseMatch,
	RELAY_REMOVAL_CONFIRMATION,
} from '@owlat/shared/deliverabilityIndependence';
import { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import type { ConvexHttpClient } from 'convex/browser';
import { requireOrgAdmin } from '~~/server/utils/requireOrgAdmin';

interface ApplyBody {
	/** The provider-key patch from the wizard's `buildProviderEnv` — SET keys only. */
	providerEnv: Record<string, string>;
	/** The phrase an operator typed to confirm losing the relay, when they did. */
	relayRemovalConfirmation?: string;
}

interface ApplyResult {
	ok: boolean;
	message: string;
	/** True when the change took effect live; false ⇒ a restart is required. */
	applied: boolean;
	requiresRestart: boolean;
}

const OWLAT_DIR = process.env['OWLAT_DIR'] || '/opt/owlat';

function refuse(message: string): ApplyResult {
	return { ok: false, applied: false, requiresRestart: false, message };
}

type IndependenceSummary = FunctionReturnType<
	typeof api.delivery.rampIndependence.getIndependenceSummary
>;

/** The removal-safety read, or `null` when it could not be made. */
async function readIndependenceSummary(
	client: ConvexHttpClient
): Promise<IndependenceSummary | null> {
	try {
		return await client.query(api.delivery.rampIndependence.getIndependenceSummary, {});
	} catch {
		return null;
	}
}

/**
 * Does this change PULL THE RELAY, and if so has its consequence been confirmed?
 * Returns the refusal to send back, or `null` to let the change through.
 *
 * "Removes the reference arm" is read off the RESULTING env rather than off the
 * patch: an operator switching one relay for another keeps a second arm and is
 * not disconnecting anything, and only a result of `mta` (or of nothing at all)
 * leaves the deployment sending on its own.
 *
 * FAIL-CLOSED ON AN UNREADABLE SUMMARY. A read that did not answer knows nothing
 * about which cells are still leaning on the relay, so it may not answer "safe"
 * on the deployment's behalf; the operator can still proceed by typing the
 * phrase, which is the same consequence confirmation they would have typed
 * anyway.
 */
async function unconfirmedRelayRemoval(
	client: ConvexHttpClient,
	confirmation: unknown
): Promise<ApplyResult | null> {
	// Confirmed first, so a confirmed change never needs the backend to answer.
	if (
		typeof confirmation === 'string' &&
		isConfirmationPhraseMatch(confirmation, RELAY_REMOVAL_CONFIRMATION)
	) {
		return null;
	}
	const summary = await readIndependenceSummary(client);
	if (summary === null) {
		return refuse(
			`Could not check which cells are still sending through the relay, so this change is not being applied blind. Type “${RELAY_REMOVAL_CONFIRMATION}” to disconnect it anyway.`
		);
	}
	if (summary.referenceTransportId === null || summary.relayRemoval.kind === 'safe') return null;
	const dependent = summary.relayRemoval.dependentCells.length;
	return refuse(
		`${dependent} ${dependent === 1 ? 'cell still sends' : 'cells still send'} part of their mail through ${summary.referenceTransportId}. Switching to your own MTA moves all of that traffic at once — not gradually — and the reputation that transport built for your domain stops being available to fall back on. Type “${RELAY_REMOVAL_CONFIRMATION}” to disconnect it anyway.`
	);
}

export default defineEventHandler(async (event): Promise<ApplyResult> => {
	const client = await requireOrgAdmin(event);

	const body = await readBody<ApplyBody>(event);
	const patch = body?.providerEnv;
	if (!patch || typeof patch !== 'object') {
		throw createError({ statusCode: 400, message: 'providerEnv is required.' });
	}

	// Only string values may be written (the allowlist itself is enforced by
	// `planTransportEnvChange` below, which rejects any non-transport key).
	for (const [key, value] of Object.entries(patch)) {
		if (typeof value !== 'string') {
			throw createError({ statusCode: 400, message: `Env value for ${key} must be a string.` });
		}
	}

	// A named provider must be a real delivery kind. `none`/receive-only simply
	// omits EMAIL_PROVIDER (the send path fails-closed), which is allowed.
	const chosen = patch['EMAIL_PROVIDER'];
	if (chosen !== undefined && !isDeliveryProviderKind(chosen)) {
		return refuse(
			`"${chosen}" is not a delivery provider. Choose your own MTA, Resend, Amazon SES, or an SMTP relay.`
		);
	}

	const envPath = resolve(OWLAT_DIR, '.env');
	let existing: Record<string, string>;
	try {
		existing = await readEnvFile(envPath);
	} catch {
		existing = {};
	}

	// Compute the env change: credentials are clear-then-set (a dropped credential
	// is gone from `.env` and pushed as '' live so `providerKindConfigured`
	// fails-closed), but the From-identity keys are PRESERVED when the patch omits
	// them — the editor shows a blank From meaning "keep the current default", so a
	// blank must never wipe DEFAULT_FROM_EMAIL/DEFAULT_FROM_NAME.
	let plan: TransportEnvPlan;
	try {
		plan = planTransportEnvChange(existing, patch);
	} catch (e) {
		if (e instanceof UnexpectedTransportEnvKeyError) {
			throw createError({ statusCode: 400, message: e.message });
		}
		throw e;
	}
	const { merged, changes } = plan;

	// THE CONSEQUENCE GATE, before anything is pushed or written. A resulting
	// provider of `mta` — or of nothing at all — is a deployment sending on its
	// own from the moment this returns.
	const resultingProvider = (merged['EMAIL_PROVIDER'] ?? '').trim();
	if (resultingProvider === '' || resultingProvider === 'mta') {
		const refusal = await unconfirmedRelayRemoval(client, body?.relayRemovalConfirmation);
		if (refusal !== null) return refusal;
	}

	// The on-disk backup gets the SEALED relay password; `changes` (the live
	// push below) keeps the working plaintext.
	const envBackup = sealRelayPasswordForBackup(merged);

	const adminKey = existing['CONVEX_ADMIN_KEY'];
	if (!adminKey) {
		// No admin key on disk (e.g. a dev checkout) — persist the choice and hand
		// off to the restart affordance instead of silently no-op'ing the live send.
		try {
			await writeEnvFile(envPath, envBackup);
		} catch (e) {
			return refuse(`Saved nothing: could not write ${envPath} (${(e as Error).message}).`);
		}
		return {
			ok: true,
			applied: false,
			requiresRestart: true,
			message:
				'Transport saved to .env. Restart the instance to load the new sending provider — this deployment applies transport changes on restart.',
		};
	}

	const convexSiteUrl = (
		process.env['CONVEX_SITE_URL'] ||
		process.env['NUXT_PUBLIC_CONVEX_SITE_URL'] ||
		existing['CONVEX_SITE_URL'] ||
		'http://localhost:3211'
	).replace(/\/+$/, '');
	const convexAdminUrl = deriveConvexAdminUrl(convexSiteUrl);

	// Push live FIRST so a failure leaves the on-disk config untouched and the
	// action retryable.
	try {
		await pushConvexRuntimeEnv(convexAdminUrl, adminKey, changes);
	} catch (e) {
		return refuse(`Could not update the delivery provider on the backend: ${(e as Error).message}`);
	}

	try {
		await writeEnvFile(envPath, envBackup);
	} catch (e) {
		// Live change already took effect; only persistence failed. Say so honestly.
		return {
			ok: true,
			applied: true,
			requiresRestart: false,
			message: `Sending switched to the new provider, but saving it to .env failed (${(e as Error).message}) — it may revert on the next restart. Check file permissions.`,
		};
	}

	return {
		ok: true,
		applied: true,
		requiresRestart: false,
		message: 'Sending now uses the new transport. The change took effect immediately.',
	};
});
