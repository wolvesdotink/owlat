import { describe, expect, it } from 'vitest';
import {
	parseSystemSenderDnsStatus,
	systemSenderDnsFindings,
	systemSenderDnsLines,
	type SystemSenderDnsStatus,
} from '../systemSenderDns';

const PENDING: SystemSenderDnsStatus = {
	state: 'pending',
	domain: 'mail.example.org',
	records: [
		{ label: 'SPF', type: 'TXT', name: 'mail.example.org', value: 'v=spf1 a -all', verified: true },
		{
			label: 'DKIM',
			type: 'TXT',
			name: 's1._domainkey.mail.example.org',
			value: 'v=DKIM1; k=rsa; p=AAAA',
			verified: null,
		},
	],
};

describe('parseSystemSenderDnsStatus', () => {
	it('reads the query answer out of convex run output', () => {
		expect(
			parseSystemSenderDnsStatus(`Running query...\n${JSON.stringify(PENDING, null, 2)}\n`)
		).toEqual(PENDING);
	});

	it('refuses an answer it does not recognise', () => {
		expect(parseSystemSenderDnsStatus('not json')).toBeNull();
		expect(parseSystemSenderDnsStatus(JSON.stringify({ state: 'pending' }))).toBeNull();
		expect(
			parseSystemSenderDnsStatus(
				JSON.stringify({ ...PENDING, records: [{ label: 'DKIM', value: 'v=DKIM1' }] })
			)
		).toBeNull();
	});
});

describe('systemSenderDnsLines', () => {
	it('lists the records the last check did not find', () => {
		expect(systemSenderDnsLines(PENDING)).toEqual([
			'DNS records for system mail from mail.example.org (also on the Domains page). Until they are published, receivers cannot verify its DKIM signature:',
			'  DKIM: TXT s1._domainkey.mail.example.org  v=DKIM1; k=rsa; p=AAAA',
		]);
	});

	it('says the key is on its way while the domain registers', () => {
		expect(
			systemSenderDnsLines({ state: 'registering', domain: 'mail.example.org', records: [] })
		).toEqual([
			'System mail is sent from mail.example.org. Its DKIM key is being generated; run `owlat doctor` for the DNS records to publish.',
		]);
	});

	it('says nothing once every record is published, or when nothing could be read', () => {
		const published = {
			...PENDING,
			state: 'verified' as const,
			records: PENDING.records.map((record) => ({ ...record, verified: true })),
		};
		expect(systemSenderDnsLines(published)).toEqual([]);
		expect(systemSenderDnsLines(null)).toEqual([]);
		expect(systemSenderDnsLines({ state: 'not_configured' })).toEqual([]);
	});
});

describe('systemSenderDnsFindings', () => {
	it('fails once per record still to publish', () => {
		expect(
			systemSenderDnsFindings(PENDING).map(({ check, ok, subject, message }) => ({
				check,
				ok,
				subject,
				message: String(message),
			}))
		).toEqual([
			{
				check: 'mta.system_sender_dns',
				ok: false,
				subject: 'DKIM',
				message:
					'Publish for system mail from mail.example.org: TXT s1._domainkey.mail.example.org v=DKIM1; k=rsa; p=AAAA',
			},
		]);
	});

	it('fails when the domain is not a sending domain', () => {
		const [finding] = systemSenderDnsFindings({
			state: 'not_registered',
			domain: 'mail.example.org',
		});
		expect(finding?.ok).toBe(false);
		expect(String(finding?.message)).toContain('add mail.example.org on the Domains page');
	});
});
