/**
 * The Deliverability Center's PURE view helpers — row → DTO, and the copy the
 * grade turns into.
 *
 * Split out of `./checklist.ts` when the leak sweep
 * took that file past the ~500 LOC ratchet `scripts/check-file-size.sh`
 * enforces. The seam is the one the file already had: `checklist.ts` is the
 * bounded READS (`loadCenterDomains`, `loadTrackingDomains`, the verification
 * context) plus the assembly, and everything here takes rows it is handed and
 * returns a shape — no `ctx`, no I/O, nothing to mock.
 *
 * A pure extraction: no behaviour, and no call site outside `./checklist.ts`.
 */

import type { DeliverabilityChecklistItem, DeliverabilityValidatorEvidence } from '@owlat/shared';
import type { Doc } from '../_generated/dataModel';
import { CURRENT_DELIVERABILITY_OBSERVED_VALUES_VERSION } from '../lib/constants';
import type { DnsProvider, VpsProvider } from './checklistGuidance';
import { isIpv6CheckId } from './checklistIpv6';

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

type GroupedItem = Pick<DeliverabilityChecklistItem, 'id' | 'severity' | 'notGraded'>;

/**
 * The Center's groups. English, like every other sentence this read model
 * returns: one payload feeds the browser, the copyable diagnostic report and
 * non-browser callers. The web paints these headings from
 * `sharedPkg.deliverabilityChecklist.groups.<key>.*`, resolved in
 * `apps/web/app/composables/useDeliverabilityChecklistCopy.ts` with these words
 * as the fallback, so a heading reworded here needs the catalog edit too
 * (`apps/web/app/__tests__/sharedRegistryCatalog.test.ts` pins the two copies
 * together). The IPv6 checks form their own group, and only once IPv6 is on.
 * Checks about a send path this deployment does not use go last, in a group
 * of their own, so the severity groups hold only what grades.
 */
export function centerGroups<T extends GroupedItem>(
	graded: readonly T[],
	ipv6Items: readonly T[],
	ipv6Enabled: boolean
) {
	const unused = (item: T) =>
		item.notGraded === 'own_mta_unused' || item.notGraded === 'marketing_off';
	const ungrouped = graded.filter((item) => !isIpv6CheckId(item.id) && !unused(item));
	const notApplicable = [...graded, ...(ipv6Enabled ? ipv6Items : [])].filter(unused);
	return [
		{
			key: 'blocking' as const,
			label: 'Blocking delivery',
			description: 'These checks can stop or reject mail.',
			items: ungrouped.filter((item) => item.severity === 'blocking'),
		},
		{
			key: 'reputation' as const,
			label: 'Hurting reputation',
			description: 'These checks affect how receivers treat future mail.',
			items: ungrouped.filter((item) => item.severity === 'reputation'),
		},
		{
			key: 'recommended' as const,
			label: 'Recommended',
			description: 'Useful hardening after the blocking path is verified.',
			items: ungrouped.filter((item) => item.severity === 'recommended'),
		},
		...(ipv6Enabled && ipv6Items.some((item) => !unused(item))
			? [
					{
						key: 'ipv6' as const,
						label: 'IPv6 sending',
						description: 'Checks for the IPv6 address the server sends from.',
						items: ipv6Items.filter((item) => !unused(item)),
					},
				]
			: []),
		...(notApplicable.length > 0
			? [
					{
						key: 'not_applicable' as const,
						label: 'Not used by this deployment',
						description:
							'These checks are about a way of sending this deployment does not use. They do not affect the grade.',
						items: notApplicable,
					},
				]
			: []),
	];
}
