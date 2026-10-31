import { api } from '@owlat/api';
import {
	getActiveProfiles,
	getFlagOwnedProfiles,
	type FeatureFlagState,
} from '@owlat/shared/featureFlags';
import { requirePlatformAdmin } from '~~/server/utils/requireAdmin';
import { getInstanceSecret, callUpdater } from '~~/server/utils/updater';
import { decodeProfileState } from '~~/server/utils/updaterResponses';

/**
 * Durable services-drift probe (plan FU4): does the running stack still match
 * the current feature-flag state?
 *
 * Driven only by drift a tab happens to observe, the "Services out of sync —
 * Apply & restart" banner would vanish on a reload (or in a second browser)
 * while the services are still drifted. This route answers the same question
 * from durable state: the updater reports the APPLIED profiles (COMPOSE_PROFILES
 * in the host `.env`), Convex reports the CURRENT resolved flags, and the
 * comparison happens here through the same `getActiveProfiles` derivation
 * /apply-profiles uses — including the env-driven deliveryProvider→mta rule,
 * read from the host `.env` by the updater rather than guessed here.
 *
 * Auth mirrors apply-profiles.post.ts: platform-admin session, then the
 * configured INSTANCE_SECRET toward the updater. Read-only on both sides.
 */

interface ProfileDriftResult {
	/** False when the updater sidecar could not be reached — see `error`. */
	reachable: boolean;
	drifted: boolean;
	/** Profiles the flags require that the applied `.env` lacks. */
	missingProfiles: string[];
	/** Profiles still applied that the flags no longer require. */
	staleProfiles: string[];
	services: unknown;
	error?: string;
}

const UNREACHABLE: Omit<ProfileDriftResult, 'error'> = {
	reachable: false,
	drifted: false,
	missingProfiles: [],
	staleProfiles: [],
	services: [],
};

export default defineEventHandler(async (event): Promise<ProfileDriftResult> => {
	const client = await requirePlatformAdmin(event);

	// An unconfigured instance secret is the same operator situation as an
	// unreachable updater — there is no in-app apply, so the UI should offer the
	// CLI fallback rather than surface a 503 the banner has no branch for.
	let instanceSecret: string;
	try {
		instanceSecret = getInstanceSecret('Drift probe not configured (INSTANCE_SECRET missing)');
	} catch (err) {
		return { ...UNREACHABLE, error: errorText(err) };
	}

	let state: ReturnType<typeof decodeProfileState>;
	try {
		const resp = await callUpdater('/profile-state', instanceSecret, {
			method: 'GET',
			signal: AbortSignal.timeout(10_000),
		});
		if (!resp.ok) {
			return { ...UNREACHABLE, error: `Updater profile-state returned ${resp.status}` };
		}
		state = decodeProfileState(await resp.json());
	} catch (err) {
		return { ...UNREACHABLE, error: errorText(err) };
	}
	if (!state) {
		return { ...UNREACHABLE, error: 'Updater profile-state answered with an unreadable body' };
	}

	const applied = state.profiles;
	const { deliveryProvider } = state;

	// getFeatureFlags returns the already-resolved map; the plugin registry is
	// deliberately absent here exactly as it is in the updater's own derivation,
	// so both sides answer with the same profile vocabulary.
	const flags = (await client.query(
		api.workspaces.featureFlags.getFeatureFlags,
		{}
	)) as FeatureFlagState;
	const expected = getActiveProfiles(flags, { deliveryProvider });

	// Drift is only meaningful over the profiles the FLAGS own. `tls` and
	// `dashboard` are written by the installer and no flag state can re-derive
	// them, so measuring them against `expected` reported every HTTPS instance as
	// permanently out of sync — a banner urging one click that would have taken
	// the Caddy edge down (see `mergeComposeProfiles`).
	const flagOwned = getFlagOwnedProfiles();
	const appliedSet = new Set(applied);
	const expectedSet = new Set(expected);
	const missingProfiles = expected.filter((profile) => !appliedSet.has(profile));
	const staleProfiles = applied
		.filter((profile) => flagOwned.has(profile) && !expectedSet.has(profile))
		.sort();

	return {
		reachable: true,
		drifted: missingProfiles.length > 0 || staleProfiles.length > 0,
		missingProfiles,
		staleProfiles,
		services: state.services ?? [],
	};
});

function errorText(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === 'object' && err !== null && 'message' in err) {
		return String((err as { message: unknown }).message);
	}
	return 'Unknown updater error';
}
