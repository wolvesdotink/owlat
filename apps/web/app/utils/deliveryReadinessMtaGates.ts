/**
 * The readiness gates that only exist for the built-in mail server: its own
 * health, its sending IPs, and what warm-up leaves of today's campaign volume.
 * A stream that goes out through an external provider gets none of them.
 *
 * Pure: plain data in, plain data out.
 */

import type { ReadinessInput } from '~/utils/deliveryReadinessTypes';
import { formatNumber } from '~/utils/formatters';
import type { LocalizedText } from '~/utils/localizedText';
import type { MailStream, ReadinessGate } from '~/utils/readinessGate';

export const READINESS_TRANSPORT_HREF = '/dashboard/admin/delivery/transport';
export const READINESS_DELIVERABILITY_HREF = '/dashboard/admin/delivery/deliverability';
export const OWN_MAIL_SERVER_LABEL: LocalizedText = 'shared.deliveryReadiness.transport.ownServer';

export const READINESS_STREAMS: readonly MailStream[] = ['transactional', 'marketing'];

export function isReadinessStreamEnabled(input: ReadinessInput, stream: MailStream): boolean {
	return input.streamsEnabled?.[stream] !== false;
}

/** The enabled streams the built-in MTA carries. */
export function ownMtaStreams(input: ReadinessInput): MailStream[] {
	return READINESS_STREAMS.filter(
		(stream) =>
			isReadinessStreamEnabled(input, stream) && input.streamTransport?.[stream].usesOwnMta
	);
}

/**
 * The built-in MTA's own health, for the streams it carries. Degraded or
 * unreachable stops mail; a stale or never-run check asks for a look, exactly
 * as the Delivery health roll-up grades it.
 */
export function mailServerGate(input: ReadinessInput): ReadinessGate | null {
	const streams = ownMtaStreams(input);
	const state = input.mailServer;
	if (streams.length === 0 || state == null) return null;
	const base = {
		key: 'mail-server' as const,
		title: 'shared.deliveryReadiness.gates.mailServer.title',
		detail: `shared.deliveryReadiness.gates.mailServer.${state}`,
		streams,
		transport: OWN_MAIL_SERVER_LABEL,
	};
	if (state === 'healthy') {
		return { ...base, status: 'ready', tone: 'success', actionHref: null, actionLabel: null };
	}
	const isBlocking = state === 'degraded' || state === 'unreachable';
	return {
		...base,
		status: 'attention',
		tone: isBlocking ? 'error' : 'warning',
		actionHref: READINESS_TRANSPORT_HREF,
		actionLabel: 'shared.deliveryReadiness.gates.mailServer.action',
		isBlocking,
	};
}

/**
 * The sending IPs of each stream the MTA carries. Every address held stops the
 * stream; some held leaves the rest carrying it. Merged into one gate when both
 * streams stand the same; no gate at all before any address is synced.
 */
export function sendingIpGates(input: ReadinessInput): ReadinessGate[] {
	const byPosture = new Map<SendingIpPosture, MailStream[]>();
	for (const stream of ownMtaStreams(input)) {
		const posture = input.sendingIps?.[stream];
		if (posture == null) continue;
		byPosture.set(posture, [...(byPosture.get(posture) ?? []), stream]);
	}
	return [...byPosture].map(([posture, streams]): ReadinessGate => {
		const base = {
			key: 'sending-ips' as const,
			title: 'shared.deliveryReadiness.gates.sendingIps.title',
			detail: `shared.deliveryReadiness.gates.sendingIps.${posture}`,
			streams,
			transport: OWN_MAIL_SERVER_LABEL,
		};
		if (posture === 'ready') {
			return { ...base, status: 'ready', tone: 'success', actionHref: null, actionLabel: null };
		}
		const isBlocking = posture === 'all_held';
		return {
			...base,
			status: 'attention',
			tone: isBlocking ? 'error' : 'warning',
			actionHref: READINESS_DELIVERABILITY_HREF,
			actionLabel: 'shared.deliveryReadiness.gates.sendingIps.action',
			isBlocking,
		};
	});
}

/**
 * Marketing: how much the own MTA's warm-up lets out today. A capped day is the
 * warm-up working, so it reads as paced, not as a problem; only a halted
 * warm-up or a day with nothing left asks for attention. An instance that
 * sends campaigns through an external provider gets no gate.
 */
export function capacityGate(input: ReadinessInput): ReadinessGate | null {
	if (!ownMtaStreams(input).includes('marketing')) return null;
	const base = {
		key: 'capacity' as const,
		title: 'shared.deliveryReadiness.gates.capacity.title',
		streams: ['marketing'] as const,
		transport: OWN_MAIL_SERVER_LABEL,
	};
	if (input.warmupHalted) {
		return {
			...base,
			detail: 'shared.deliveryReadiness.gates.capacity.halted',
			status: 'attention',
			tone: 'warning',
			actionHref: READINESS_DELIVERABILITY_HREF,
			actionLabel: 'shared.deliveryReadiness.gates.capacity.action',
		};
	}
	const capacity = input.marketingCapacity;
	if (capacity == null) return null;
	if (!capacity.paced) {
		return {
			...base,
			detail: 'shared.deliveryReadiness.gates.capacity.unpaced',
			status: 'ready',
			tone: 'success',
			actionHref: null,
			actionLabel: null,
		};
	}
	if (capacity.today <= 0) {
		return {
			...base,
			detail: 'shared.deliveryReadiness.gates.capacity.usedUp',
			status: 'attention',
			tone: 'warning',
			actionHref: null,
			actionLabel: null,
		};
	}
	return {
		...base,
		detail: {
			key: 'shared.deliveryReadiness.gates.capacity.paced',
			params: { count: formatNumber(capacity.today) },
		},
		status: 'ready',
		tone: 'neutral',
		actionHref: null,
		actionLabel: null,
	};
}
