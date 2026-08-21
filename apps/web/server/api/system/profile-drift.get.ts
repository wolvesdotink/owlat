import { api } from '@owlat/api';
import { getActiveProfiles, type FeatureFlagState } from '@owlat/shared/featureFlags';
import { requirePlatformAdmin } from '~~/server/utils/requireAdmin';
import { getInstanceSecret, callUpdater } from '~~/server/utils/updater';

/**
 * Durable services-drift probe (plan FU4): does the running stack still match
 * the current feature-flag state?
 *
 * The "Services out of sync — Apply & restart" banner used to be driven purely
 * by drift a tab happened to observe, so a reload (or a second browser) lost it
 * while the services were still drifted. This route answers the same question
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

interface UpdaterProfileState {
	profiles?: unknown;
	deliveryProvider?: unknown;
	services?: unknown;
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

	let state: UpdaterProfileState;
	try {
		const resp = await callUpdater('/profile-state', instanceSecret, {
			method: 'GET',
			signal: AbortSignal.timeout(10_000),
		});
		if (!resp.ok) {
			return { ...UNREACHABLE, error: `Updater profile-state returned ${resp.status}` };
		}
		state = (await resp.json()) as UpdaterProfileState;
	} catch (err) {
		return { ...UNREACHABLE, error: errorText(err) };
	}

	const applied = Array.isArray(state.profiles) ? state.profiles.filter(isString) : [];
	const deliveryProvider =
		typeof state.deliveryProvider === 'string' ? state.deliveryProvider : undefined;

	// getFeatureFlags returns the already-resolved map; the plugin registry is
	// deliberately absent here exactly as it is in the updater's own derivation,
	// so both sides answer with the same profile vocabulary.
	const flags = (await client.query(
		api.workspaces.featureFlags.getFeatureFlags,
		{}
	)) as FeatureFlagState;
	const expected = getActiveProfiles(flags, { deliveryProvider });

	const appliedSet = new Set(applied);
	const expectedSet = new Set(expected);
	const missingProfiles = expected.filter((profile) => !appliedSet.has(profile));
	const staleProfiles = applied.filter((profile) => !expectedSet.has(profile)).sort();

	return {
		reachable: true,
		drifted: missingProfiles.length > 0 || staleProfiles.length > 0,
		missingProfiles,
		staleProfiles,
		services: state.services ?? [],
	};
});

function isString(value: unknown): value is string {
	return typeof value === 'string';
}

function errorText(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === 'object' && err !== null && 'message' in err) {
		return String((err as { message: unknown }).message);
	}
	return 'Unknown updater error';
}
