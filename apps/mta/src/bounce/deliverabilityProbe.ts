import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import type Redis from 'ioredis';
import { ipAddressFamily, normalizeIpAddress } from '@owlat/shared/ipAddress';
import {
	DELIVERABILITY_PROBE_LOCAL_PREFIX,
	verifyDeliverabilityProbeToken,
} from '@owlat/shared/deliverabilityProbeToken';
import type { MtaConfig } from '../config.js';
import { queueConvexWebhook } from '../webhooks/convexNotifier.js';

/** Parse the reserved, unshadowable Deliverability Center loopback recipient. */
export function deliverabilityProbeToken(
	recipient: string,
	returnPathDomain: string,
	webhookSecret: string,
	now = Date.now()
): string | null {
	const separator = recipient.lastIndexOf('@');
	if (separator <= DELIVERABILITY_PROBE_LOCAL_PREFIX.length) return null;
	const local = recipient.slice(0, separator);
	const domain = recipient
		.slice(separator + 1)
		.toLowerCase()
		.replace(/\.$/, '');
	if (domain !== returnPathDomain.toLowerCase().replace(/\.$/, '')) return null;
	if (!local.toLowerCase().startsWith(DELIVERABILITY_PROBE_LOCAL_PREFIX)) return null;
	const token = local.slice(DELIVERABILITY_PROBE_LOCAL_PREFIX.length);
	return verifyDeliverabilityProbeToken(token, webhookSecret, now) ? token : null;
}

function isReservedProbeRecipient(recipient: string, returnPathDomain: string): boolean {
	const separator = recipient.lastIndexOf('@');
	if (separator <= DELIVERABILITY_PROBE_LOCAL_PREFIX.length) return false;
	return (
		recipient.slice(0, separator).toLowerCase().startsWith(DELIVERABILITY_PROBE_LOCAL_PREFIX) &&
		recipient
			.slice(separator + 1)
			.toLowerCase()
			.replace(/\.$/, '') === returnPathDomain.toLowerCase().replace(/\.$/, '')
	);
}

export function deliverabilityProbeRecipientDecision(
	recipient: string,
	existingRecipients: string[],
	returnPathDomain: string,
	webhookSecret: string,
	now = Date.now()
):
	| { kind: 'probe'; token: string }
	| { kind: 'normal' }
	| { kind: 'invalid_reserved_probe' }
	| { kind: 'mixed' } {
	const token = deliverabilityProbeToken(recipient, returnPathDomain, webhookSecret, now);
	if (!token && isReservedProbeRecipient(recipient, returnPathDomain)) {
		return { kind: 'invalid_reserved_probe' };
	}
	const existingHasProbe = existingRecipients.some(
		(address) => deliverabilityProbeToken(address, returnPathDomain, webhookSecret, now) !== null
	);
	if ((token && existingRecipients.length > 0) || (!token && existingHasProbe)) {
		return { kind: 'mixed' };
	}
	return token ? { kind: 'probe', token } : { kind: 'normal' };
}

function probeIdentity(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function forwardConfirmedPtr(ip: string): Promise<string> {
	try {
		const expected = normalizeIpAddress(ip);
		const family = ipAddressFamily(ip);
		if (!expected || !family) return 'missing';
		const ptrNames = [
			...new Set(
				(await dns.reverse(ip))
					.slice(0, 10)
					.map((value) => value.toLowerCase().replace(/\.$/, ''))
					.filter(Boolean)
			),
		].sort();
		for (const ptr of ptrNames) {
			const forwards =
				family === 'ipv4'
					? await dns.resolve4(ptr).catch(() => [])
					: await dns.resolve6(ptr).catch(() => []);
			if (forwards.some((answer) => normalizeIpAddress(answer) === expected)) return ptr;
		}
		return 'missing';
	} catch {
		return 'missing';
	}
}

export async function recordDeliverabilityProbe(
	input: {
		token: string;
		spfResult: string;
		dkimResult: string;
		dmarcResult: string;
		dkimSelector?: string;
		remoteAddress: string;
		tlsProtocol?: string;
	},
	config: MtaConfig,
	redis: Redis
): Promise<void> {
	const identity = probeIdentity(input.token);
	await queueConvexWebhook(
		{
			event: 'deliverability.probe_observed',
			eventId: `deliverability-probe:${identity}`,
			probeToken: input.token,
			spfResult: input.spfResult,
			dkimResult: input.dkimResult,
			dmarcResult: input.dmarcResult,
			...(input.dkimSelector ? { selector: input.dkimSelector } : {}),
			ip: input.remoteAddress,
			tlsVersion: input.tlsProtocol ?? 'plaintext',
			ptr: await forwardConfirmedPtr(input.remoteAddress),
			timestamp: Date.now(),
		},
		config,
		redis,
		`deliverability-probe:${identity}`
	);
}

export async function recordDeliverabilityProbeIfPresent(
	input: {
		recipientCount: number;
		acceptedToken?: string;
		spfResult: string;
		dkimResult: string;
		dmarcResult: string;
		dkimSelector?: string;
		remoteAddress: string;
		tlsProtocol?: string;
	},
	config: MtaConfig,
	redis: Redis
): Promise<boolean> {
	if (!input.acceptedToken || input.recipientCount !== 1) return false;
	await recordDeliverabilityProbe({ ...input, token: input.acceptedToken }, config, redis);
	return true;
}
