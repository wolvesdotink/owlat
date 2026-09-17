import { describe, expect, it } from 'vitest';
import { coreSendProviderCatalogEntry, SEND_TRANSPORT_KINDS } from '../sendProviderCatalog';
import { egressOf } from '../sendProviderCapabilities';
import {
	selectPortChecks,
	summarizePortChecks,
	type PortCheckId,
	type PortCheckOutcome,
} from '../networkPorts';

function relevanceOf(
	id: PortCheckId,
	context: Parameters<typeof selectPortChecks>[0]
): string | undefined {
	return selectPortChecks(context).find((check) => check.id === id)?.relevance;
}

function outcome(
	id: PortCheckId,
	status: PortCheckOutcome['status'],
	relevance: PortCheckOutcome['relevance'] = 'required'
): PortCheckOutcome {
	return { id, status, relevance };
}

/** The catalog is only reachable through the selector, so it is asserted there. */
const CATALOG = selectPortChecks({ profiles: [] });

describe('the catalog', () => {
	it('declares every check exactly once', () => {
		const ids = CATALOG.map((check) => check.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('covers both directions', () => {
		expect(CATALOG.some((check) => check.direction === 'inbound')).toBe(true);
		expect(CATALOG.some((check) => check.direction === 'outbound')).toBe(true);
	});

	it('dials a compose service inbound and a public host outbound', () => {
		for (const check of CATALOG) {
			if (check.direction === 'inbound') expect(check.target).not.toContain('.');
			else expect(check.target).toContain('.');
		}
	});
});

describe('selectPortChecks', () => {
	it('always requires the app, egress-HTTPS and DNS paths', () => {
		const context = { profiles: [] };
		expect(relevanceOf('inbound-https', context)).toBe('required');
		expect(relevanceOf('outbound-https', context)).toBe('required');
		expect(relevanceOf('outbound-dns', context)).toBe('required');
	});

	it('lists every catalog entry whether or not it is required', () => {
		// Not a filter: an operator checks a port BEFORE turning the feature on,
		// so an unneeded port is listed as unneeded rather than hidden.
		expect(selectPortChecks({ profiles: ['mta'] })).toHaveLength(CATALOG.length);
		expect(CATALOG.some((check) => check.relevance === 'optional')).toBe(true);
	});

	it('requires ACME port 80 only when Caddy terminates TLS', () => {
		expect(relevanceOf('inbound-http', { profiles: [] })).toBe('optional');
		expect(relevanceOf('inbound-http', { profiles: ['tls'] })).toBe('required');
	});

	it('requires inbound 25 with the built-in MTA and inbound 993 with personal mail', () => {
		expect(relevanceOf('inbound-smtp', { profiles: ['mta'] })).toBe('required');
		expect(relevanceOf('inbound-imaps', { profiles: ['mta'] })).toBe('optional');
		expect(relevanceOf('inbound-imaps', { profiles: ['personal-mail'] })).toBe('required');
	});

	it('requires outbound 25 only for direct-to-MX delivery', () => {
		expect(relevanceOf('outbound-smtp', { profiles: ['mta'], deliveryProvider: 'mta' })).toBe(
			'required'
		);
		// The MTA also runs as a bounce/receive path behind an API provider; that
		// deployment never dials a recipient MX itself.
		expect(relevanceOf('outbound-smtp', { profiles: ['mta'], deliveryProvider: 'resend' })).toBe(
			'optional'
		);
	});

	it('requires submission for an SMTP relay and leaves implicit TLS optional', () => {
		const context = { profiles: [], deliveryProvider: 'smtp' };
		expect(relevanceOf('outbound-submission', context)).toBe('required');
		expect(relevanceOf('outbound-smtps', context)).toBe('optional');
	});

	/**
	 * The mail port a transport needs is read off its catalog entry, not matched
	 * against its name — so a transport this module has never heard of (a bundled
	 * plugin's, which `@owlat/shared` cannot see) claims no mail port rather than
	 * painting a red row for a port the instance never dials.
	 */
	it('asks the transport catalog which egress path is in use', () => {
		for (const kind of SEND_TRANSPORT_KINDS) {
			const context = { profiles: [], deliveryProvider: kind };
			const egress = egressOf(coreSendProviderCatalogEntry(kind));
			expect(relevanceOf('outbound-smtp', context)).toBe(
				egress === 'recipient-mx' ? 'required' : 'optional'
			);
			expect(relevanceOf('outbound-submission', context)).toBe(
				egress === 'smtp-relay' ? 'required' : 'optional'
			);
		}
	});

	it('claims no mail port for a transport the core catalog does not declare', () => {
		const context = { profiles: [], deliveryProvider: 'acme-plugin/courier' };
		expect(relevanceOf('outbound-smtp', context)).toBe('optional');
		expect(relevanceOf('outbound-submission', context)).toBe('optional');
		expect(relevanceOf('outbound-https', context)).toBe('required');
	});

	it('requires both mailbox ports once external mailboxes are enabled', () => {
		const context = { profiles: ['external-mail'] };
		expect(relevanceOf('outbound-imaps', context)).toBe('required');
		expect(relevanceOf('outbound-smtps', context)).toBe('required');
	});
});

describe('summarizePortChecks', () => {
	it('is ok when every required check is open', () => {
		expect(
			summarizePortChecks([outcome('inbound-https', 'open'), outcome('outbound-dns', 'open')])
		).toBe('ok');
	});

	it('ignores optional failures', () => {
		expect(
			summarizePortChecks([
				outcome('inbound-https', 'open'),
				outcome('outbound-smtp', 'blocked', 'optional'),
			])
		).toBe('ok');
	});

	it('degrades on a blocked or refused required port', () => {
		expect(summarizePortChecks([outcome('outbound-imaps', 'blocked')])).toBe('degraded');
		expect(summarizePortChecks([outcome('inbound-smtp', 'refused')])).toBe('degraded');
	});

	it('reports unknown — not degraded — when the probe itself could not answer', () => {
		expect(summarizePortChecks([outcome('outbound-dns', 'error')])).toBe('unknown');
		expect(summarizePortChecks([outcome('inbound-imaps', 'skipped')])).toBe('unknown');
	});

	it('prefers degraded over unknown when both are present', () => {
		expect(
			summarizePortChecks([outcome('outbound-dns', 'error'), outcome('outbound-imaps', 'blocked')])
		).toBe('degraded');
	});
});
