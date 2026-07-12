import { describe, it, expect } from 'vitest';
import {
	buildInboundMxRecords,
	buildMtaStsDnsRecords,
	hasInboundFeature,
	INBOUND_MX_PRIORITY,
} from '../inboundDns';

describe('buildMtaStsDnsRecords', () => {
	it('builds the _mta-sts TXT + mta-sts CNAME records', () => {
		expect(buildMtaStsDnsRecords('abcd1234abcd1234', 'acme.owlat.app')).toEqual([
			{ type: 'TXT', host: '_mta-sts', value: 'v=STSv1; id=abcd1234abcd1234' },
			{ type: 'CNAME', host: 'mta-sts', value: 'acme.owlat.app' },
		]);
	});

	it('lowercases and strips a port + trailing dot from the web host', () => {
		expect(buildMtaStsDnsRecords('id123', 'ACME.owlat.app:443.')).toEqual([
			{ type: 'TXT', host: '_mta-sts', value: 'v=STSv1; id=id123' },
			{ type: 'CNAME', host: 'mta-sts', value: 'acme.owlat.app' },
		]);
	});

	it('returns [] when there is no policy id (nothing published)', () => {
		expect(buildMtaStsDnsRecords(null, 'acme.owlat.app')).toEqual([]);
		expect(buildMtaStsDnsRecords('', 'acme.owlat.app')).toEqual([]);
	});

	it('returns [] when there is no known web host', () => {
		expect(buildMtaStsDnsRecords('id123', null)).toEqual([]);
		expect(buildMtaStsDnsRecords('id123', '  ')).toEqual([]);
	});
});

describe('buildInboundMxRecords', () => {
	it('builds the apex MX record pointing at the deployment mail host', () => {
		expect(buildInboundMxRecords('example.com', 'mail.example.com')).toEqual([
			{ type: 'MX', host: '@', priority: INBOUND_MX_PRIORITY, value: 'mail.example.com' },
		]);
	});

	it('uses the same deployment mail host regardless of the receiving domain', () => {
		const records = buildInboundMxRecords('acme.test', 'mail.owlat.example');
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ host: '@', value: 'mail.owlat.example' });
	});

	it('lowercases and strips a trailing root dot from the mail host', () => {
		expect(buildInboundMxRecords('example.com', 'Mail.Example.Com.')[0]?.value).toBe(
			'mail.example.com'
		);
	});

	it('returns [] when the deployment has no mail host configured', () => {
		expect(buildInboundMxRecords('example.com', null)).toEqual([]);
		expect(buildInboundMxRecords('example.com', undefined)).toEqual([]);
		expect(buildInboundMxRecords('example.com', '   ')).toEqual([]);
	});

	it('returns [] for a blank domain', () => {
		expect(buildInboundMxRecords('', 'mail.example.com')).toEqual([]);
		expect(buildInboundMxRecords('   ', 'mail.example.com')).toEqual([]);
	});
});

describe('hasInboundFeature', () => {
	it('is true when any inbound flag is on', () => {
		expect(hasInboundFeature({ inbox: true })).toBe(true);
		expect(hasInboundFeature({ postbox: true })).toBe(true);
		expect(hasInboundFeature({ 'mail.external': true })).toBe(true);
		expect(hasInboundFeature({ 'inbox.codeTasks': true })).toBe(true);
	});

	it('is false when no inbound flag is on (send-only install)', () => {
		expect(hasInboundFeature({ campaigns: true, transactional: true, inbox: false })).toBe(false);
		expect(hasInboundFeature({})).toBe(false);
	});

	it('is false while the flag map is still loading', () => {
		expect(hasInboundFeature(null)).toBe(false);
		expect(hasInboundFeature(undefined)).toBe(false);
	});
});
