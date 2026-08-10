/**
 * The Deliverability Center's PURE view helpers — row → DTO, and the copy the
 * grade turns into.
 *
 * Split out of `./checklist.ts` when the leak sweep (the seams plan's P0.4)
 * took that file past the ~500 LOC ratchet `scripts/check-file-size.sh`
 * enforces. The seam is the one the file already had: `checklist.ts` is the
 * bounded READS (`loadCenterDomains`, `loadTrackingDomains`, the verification
 * context) plus the assembly, and everything here takes rows it is handed and
 * returns a shape — no `ctx`, no I/O, nothing to mock.
 *
 * A pure extraction: no behaviour, and no call site outside `./checklist.ts`.
 */

import type { DeliverabilityValidatorEvidence } from '@owlat/shared';
import type { Doc } from '../_generated/dataModel';
import { CURRENT_DELIVERABILITY_OBSERVED_VALUES_VERSION } from '../lib/constants';
import type { DnsProvider, VpsProvider } from './checklistGuidance';

export function loopbackResult(row: Doc<'deliverabilityLoopbackAttempts'>) {
	return {
		status: row.status,
		startedAt: row.startedAt,
		...(row.completedAt ? { completedAt: row.completedAt } : {}),
		domain: row.domain,
		...(row.spf ? { spf: row.spf } : {}),
		...(row.dkim ? { dkim: row.dkim } : {}),
		...(row.dmarc ? { dmarc: row.dmarc } : {}),
		...(row.dkimSelector ? { dkimSelector: row.dkimSelector } : {}),
		...(row.tlsVersion ? { tlsVersion: row.tlsVersion } : {}),
		...(row.sendingIp ? { sendingIp: row.sendingIp } : {}),
		...(row.ptr ? { ptr: row.ptr } : {}),
		...(row.detail ? { detail: row.detail } : {}),
	};
}

export function providerFromEvidence(values: readonly string[]): {
	vps: VpsProvider | null;
	dns: DnsProvider | null;
} {
	let vps: VpsProvider | null = null;
	let dns: DnsProvider | null = null;
	for (const value of values) {
		if (
			value === 'vps-provider=hetzner' ||
			value === 'vps-provider=digitalocean' ||
			value === 'vps-provider=ovh'
		) {
			vps = value.slice('vps-provider='.length) as VpsProvider;
		}
		if (
			value === 'dns-provider=cloudflare' ||
			value === 'dns-provider=hetzner_dns' ||
			value === 'dns-provider=route53'
		) {
			dns = value.slice('dns-provider='.length) as DnsProvider;
		}
	}
	return { vps, dns };
}

/**
 * Evidence recorded under an older observed-values vocabulary is dropped rather
 * than replayed: the strings are the validator's own, and a stale spelling read
 * back as current would put yesterday's vocabulary on today's screen.
 */
function compatibleObservedValues(row: Doc<'deliverabilityEvidence'>): string[] {
	return row.observedValuesVersion === undefined ||
		row.observedValuesVersion === CURRENT_DELIVERABILITY_OBSERVED_VALUES_VERSION
		? row.observedValues
		: [];
}

export function evidenceDto(
	row: Doc<'deliverabilityEvidence'> | undefined
): DeliverabilityValidatorEvidence | null {
	if (!row) return null;
	return {
		provenance: 'validator',
		validator: row.validator,
		status: row.status,
		observedAt: row.observedAt,
		observedValues: compatibleObservedValues(row),
		diagnostic: row.diagnostic,
		attemptId: row.attemptId,
	};
}

/**
 * Length-prefixed so a target key containing the separator cannot collide with
 * a different (targetKey, itemId) pair.
 */
export function scopedItemKey(targetKey: string, itemId: string): string {
	return `${targetKey.length}:${targetKey}|${itemId}`;
}

export function summaryFor(
	grade: 'ready' | 'needs_attention' | 'at_risk',
	recommended: number
): string {
	if (grade === 'ready') {
		return recommended === 0
			? 'Your mail setup is verified and ready.'
			: `Your mail is deliverable. ${recommended} recommended improvement${
					recommended === 1 ? '' : 's'
				} available.`;
	}
	if (grade === 'at_risk') {
		return 'Your mail is at risk. Fix the blocking item below before sending.';
	}
	return 'Your mail needs attention. Follow the next verified setup step below.';
}
