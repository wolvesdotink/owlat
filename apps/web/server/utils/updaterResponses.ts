import { isRecord } from '@owlat/shared/utils/guards';

/**
 * Decoders for the updater sidecar's JSON answers, shared by the session-authed
 * system routes that proxy to it.
 *
 * The fields a route reads are checked here; a field of the wrong type is
 * dropped, never trusted. Every other field stays on the decoded object: these
 * routes forward the answer to the admin UI (as the body, or as an error's
 * `data`), and an updater one release ahead may already send a field this
 * build has never heard of.
 */

/** One step of a rollout, the shape `recordUpdateFinish` stores. */
interface UpdaterStep {
	step: string;
	ok?: boolean;
	stdout: string;
	stderr: string;
}

/** An answer from `/update` or `/apply-profiles`, success or failure. */
export interface UpdaterReport {
	[field: string]: unknown;
	success?: boolean;
	error?: string;
	/** `started`: applied and running, but not every service healthy in time. */
	rollout?: string;
	profiles?: string[];
	steps?: UpdaterStep[];
}

/** The `/port-checks` answer. */
export interface PortChecksReport extends UpdaterReport {
	verdict?: string;
	checkedAt?: number;
}

/** The `/profile-state` answer: what the host `.env` has applied. */
interface ProfileState {
	/** Applied compose profiles; entries that are not strings are skipped. */
	profiles: string[];
	deliveryProvider?: string;
	services?: unknown;
}

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((entry) => typeof entry === 'string');

function decodeStep(value: unknown): UpdaterStep | null {
	if (!isRecord(value)) return null;
	const { step, ok, stdout, stderr } = value;
	if (typeof step !== 'string' || typeof stdout !== 'string' || typeof stderr !== 'string') {
		return null;
	}
	if (ok !== undefined && typeof ok !== 'boolean') return null;
	return { step, ...(ok === undefined ? {} : { ok }), stdout, stderr };
}

/** The steps, or `undefined` when the field is absent or any entry is malformed. */
function decodeSteps(value: unknown): UpdaterStep[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const steps: UpdaterStep[] = [];
	for (const entry of value) {
		const step = decodeStep(entry);
		if (!step) return undefined;
		steps.push(step);
	}
	return steps;
}

/** The report, or `null` when the body is not a JSON object. */
export function decodeUpdaterReport(value: unknown): UpdaterReport | null {
	if (!isRecord(value)) return null;
	const { success, error, rollout, profiles, steps, ...rest } = value;
	const decodedSteps = decodeSteps(steps);
	return {
		...rest,
		...(typeof success === 'boolean' ? { success } : {}),
		...(typeof error === 'string' ? { error } : {}),
		...(typeof rollout === 'string' ? { rollout } : {}),
		...(isStringArray(profiles) ? { profiles } : {}),
		...(decodedSteps ? { steps: decodedSteps } : {}),
	};
}

/** The report, or `null` when the body is not a JSON object. */
export function decodePortChecksReport(value: unknown): PortChecksReport | null {
	const decoded = decodeUpdaterReport(value);
	if (!decoded) return null;
	const { verdict, checkedAt, ...report } = decoded;
	return {
		...report,
		...(typeof verdict === 'string' ? { verdict } : {}),
		...(typeof checkedAt === 'number' && Number.isFinite(checkedAt) ? { checkedAt } : {}),
	};
}

/**
 * The state, or `null` when the body is not a JSON object. Inside one, a field
 * of the wrong type reads as absent, as it always has.
 */
export function decodeProfileState(value: unknown): ProfileState | null {
	if (!isRecord(value)) return null;
	const { profiles, deliveryProvider, services } = value;
	return {
		profiles: Array.isArray(profiles)
			? profiles.filter((profile): profile is string => typeof profile === 'string')
			: [],
		...(typeof deliveryProvider === 'string' ? { deliveryProvider } : {}),
		...(services === undefined ? {} : { services }),
	};
}
