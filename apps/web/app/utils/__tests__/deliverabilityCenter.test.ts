import type { Id } from '@owlat/api/dataModel';
import { describe, expect, it, vi } from 'vitest';
import type { DeliverabilityCenter, DeliverabilityChecklistItem } from '../deliverabilityCenter';
import {
	buildDeliverabilityReport,
	checklistItemDomId,
	countDeliverabilityItems,
	findDeliverabilityItem,
	formatRecheckCountdown,
	formatVerificationAge,
	itemKey,
} from '../deliverabilityCenter';

function domainItem(
	domainId: Id<'domains'>,
	status: DeliverabilityChecklistItem['status']
): DeliverabilityChecklistItem {
	return {
		id: 'domain.spf',
		title: 'Tell the world who may send for your domain',
		protocol: 'SPF with -all',
		severity: 'blocking',
		impact: 'SPF authorizes Owlat.',
		docsHref: '/guide/deliverability',
		dependencies: [],
		dnsBacked: true,
		scope: { kind: 'domain', domainId, domain: `${domainId}.example` },
		status,
		lastCheckedAt: Date.UTC(2026, 6, 25),
		observed: ['v=spf1 -all'],
		diagnosticReport: 'TXT lookup returned v=spf1 -all',
	};
}

describe('Deliverability Center view model', () => {
	it('scope-qualifies repeated per-domain checklist ids', () => {
		const first = domainItem('domain-a' as Id<'domains'>, 'pass');
		const second = domainItem('domain-b' as Id<'domains'>, 'fail');

		expect(itemKey(first.scope, first.id)).toBe('domain:domain-a:domain.spf');
		expect(itemKey(second.scope, second.id)).toBe('domain:domain-b:domain.spf');
		expect(itemKey(first.scope, first.id)).not.toBe(itemKey(second.scope, second.id));
		expect(itemKey({ kind: 'deployment' }, 'deployment.ptr')).toBe('deployment:deployment.ptr');
		expect(checklistItemDomId(first)).toBe('deliverability-check:domain:domain-a:domain.spf');
		expect(
			findDeliverabilityItem(
				[{ key: 'blocking', label: '', description: '', items: [first, second] }],
				{ itemId: 'domain.spf', domainId: 'domain-b' as Id<'domains'> }
			)
		).toBe(second);
	});

	it('counts verified, attention, and propagation states without conflating them', () => {
		const domainId = 'domain-a' as Id<'domains'>;
		const items = [
			domainItem(domainId, 'pass'),
			{ ...domainItem(domainId, 'warn'), id: 'domain.dkim' as const },
			{ ...domainItem(domainId, 'fail'), id: 'domain.dmarc' as const },
			{ ...domainItem(domainId, 'pending-dns'), id: 'domain.return_path' as const },
		];
		expect(
			countDeliverabilityItems([
				{ key: 'blocking', label: 'Blocking delivery', description: '', items },
			])
		).toEqual({ passing: 1, attention: 2, pending: 1, total: 4 });
	});

	it('formats honest check ages and a live DNS countdown', () => {
		const now = Date.UTC(2026, 6, 26, 12);
		expect(formatVerificationAge(now - 30_000, now)).toBe('checked just now');
		expect(formatVerificationAge(now - 2 * 60_000, now)).toBe('checked 2 min ago');
		expect(formatVerificationAge(now - 3 * 3_600_000, now)).toBe('checked 3 h ago');
		expect(formatRecheckCountdown(now + 4 * 60_000 + 32_000, now)).toBe('4:32');
	});

	it('exports validator evidence and end-to-end proof without claiming more than observed', () => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.UTC(2026, 6, 26, 12));
		const item = domainItem('domain-a' as Id<'domains'>, 'pass');
		const center: DeliverabilityCenter = {
			grade: 'ready',
			summary: 'Your mail is deliverable.',
			checkedAt: Date.UTC(2026, 6, 26, 11),
			statusRefreshedAt: Date.UTC(2026, 6, 26, 12),
			alerts: [],
			nextItem: null,
			groups: [{ key: 'blocking', label: 'Blocking delivery', description: '', items: [item] }],
			loopback: {
				domains: [
					{
						id: 'domain-a' as Id<'domains'>,
						domain: 'domain-a.example',
						eligible: true,
						latest: {
							status: 'passed',
							startedAt: Date.UTC(2026, 6, 26, 11, 30),
							completedAt: Date.UTC(2026, 6, 26, 11, 31),
							domain: 'domain-a.example',
							spf: 'pass',
							dkim: 'pass',
							dkimSelector: 'owlat1',
							dmarc: 'pass',
							tlsVersion: 'TLS 1.3',
							sendingIp: '203.0.113.7',
							ptr: 'mail.domain-a.example',
						},
					},
				],
			},
		};

		const report = buildDeliverabilityReport(center);
		expect(report).toContain('[Verified] Tell the world who may send for your domain');
		expect(report).toContain('Observed: v=spf1 -all');
		expect(report).toContain('DKIM: pass (owlat1)');
		expect(report).toContain('Sending IP: 203.0.113.7');
		expect(report).not.toContain('guaranteed');
		vi.useRealTimers();
	});

	it('states when no validator has completed instead of formatting the Unix epoch', () => {
		const center: DeliverabilityCenter = {
			grade: 'at_risk',
			summary: 'No live evidence is available yet.',
			checkedAt: null,
			statusRefreshedAt: Date.UTC(2026, 6, 26, 12),
			alerts: [],
			nextItem: null,
			groups: [],
			loopback: { domains: [] },
		};

		const report = buildDeliverabilityReport(center);
		expect(report).toContain('Latest validator evidence: No validator evidence yet');
		expect(report).not.toContain('1970-01-01');
	});

	it('preserves a Ready grade while counting recommended improvements as attention', () => {
		const recommended = {
			...domainItem('domain-a' as Id<'domains'>, 'warn'),
			id: 'domain.mta_sts' as const,
			severity: 'recommended' as const,
		};
		const center: DeliverabilityCenter = {
			grade: 'ready',
			summary: 'Your mail is deliverable. 1 recommended improvement available.',
			checkedAt: recommended.lastCheckedAt ?? null,
			statusRefreshedAt: Date.UTC(2026, 6, 26, 12),
			alerts: [],
			nextItem: recommended,
			groups: [
				{
					key: 'recommended',
					label: 'Recommended',
					description: 'Useful hardening after the blocking path is verified.',
					items: [recommended],
				},
			],
			loopback: { domains: [] },
		};

		expect(countDeliverabilityItems(center.groups)).toEqual({
			passing: 0,
			attention: 1,
			pending: 0,
			total: 1,
		});
		expect(buildDeliverabilityReport(center)).toContain('Overall: Ready');
		expect(center.nextItem?.id).toBe('domain.mta_sts');
	});
});
