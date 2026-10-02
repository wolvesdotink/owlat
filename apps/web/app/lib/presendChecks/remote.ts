/**
 * The pre-send checks' server half as the checks see it: the shape
 * `emailTemplates/presendChecksActions.run` answers with, where that round trip
 * stands, and the wording of a probe result.
 */
import type { LocalizedText } from '~/utils/localizedText';
import type { PresendCheck } from './types';

export const PRESEND_KEY = 'components.campaigns.presendChecks';
const KEY = PRESEND_KEY;

/** Mirrors `emailTemplates/presendProbes.ts`. */
export type ProbeStatus =
	| 'ok'
	| 'broken'
	| 'unverified'
	| 'unreachable'
	| 'blocked'
	| 'timeout'
	| 'skipped';

export interface ProbeResult {
	url: string;
	status: ProbeStatus;
	httpStatus?: number;
	bytes?: number;
	bytesAtLeast?: boolean;
}

/** Mirrors `presendChecksActions.run`'s answer. */
export interface PresendRemoteResult {
	links: ProbeResult[];
	images: ProbeResult[];
	screening:
		| {
				status: 'ready';
				verdict: {
					enabled: boolean;
					verdict: 'accept' | 'reject';
					reason?: 'empty_body' | 'content_too_large' | 'blocked_url' | 'spam_score';
					blockedPattern?: string;
					sizeLimitKb: number;
					spam?: { score: number; threshold: number };
				};
		  }
		| { status: 'unavailable' }
		| { status: 'too_large' }
		| { status: 'not_requested' };
}

export type PresendRemote =
	| { status: 'pending' }
	| { status: 'failed' }
	| { status: 'done'; result: PresendRemoteResult };

const PROBE_REASON: Partial<Record<ProbeStatus, string>> = {
	unreachable: `${KEY}.reasons.unreachable`,
	timeout: `${KEY}.reasons.timeout`,
	blocked: `${KEY}.reasons.privateAddress`,
};

export function probeReason(result: ProbeResult): LocalizedText {
	if (result.status === 'broken') {
		return result.httpStatus
			? { key: `${KEY}.reasons.httpStatus`, params: { status: result.httpStatus } }
			: `${KEY}.reasons.redirectLoop`;
	}
	return PROBE_REASON[result.status] ?? `${KEY}.reasons.unreachable`;
}

export const isProblem = (status: ProbeStatus) =>
	status === 'broken' || status === 'unreachable' || status === 'timeout' || status === 'blocked';

export function remoteUnavailable(
	id: PresendCheck['id'],
	category: PresendCheck['category'],
	remote: PresendRemote
): PresendCheck | null {
	if (remote.status === 'pending') {
		return { id, category, status: 'pending', summary: `${KEY}.${id}.pending`, items: [] };
	}
	if (remote.status === 'failed') {
		return { id, category, status: 'skipped', summary: `${KEY}.remoteFailed`, items: [] };
	}
	return null;
}

/** `pass`, or `warning` as soon as there is something to show. */
export const verdict = (status: PresendCheck['status'], items: readonly unknown[]) =>
	items.length > 0 ? 'warning' : status;
