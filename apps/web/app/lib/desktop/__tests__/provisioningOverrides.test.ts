import { describe, it, expect } from 'vitest';
import {
	SUBDOMAINS,
	SUBDOMAIN_KEYS,
	SUBDOMAIN_FIELDS,
	defaultSubdomainLabels,
	deriveHostnames,
	networkUrlsFromHosts,
	validateSubdomainLabel,
	validateSubdomainLabels,
	subdomainFieldLabel,
	type SubdomainLabels,
} from '../provisioning';
import { buildDnsRecords } from '../provisioningForm';

/** The default labels with the given fields overridden. */
function withOverrides(overrides: Partial<SubdomainLabels>): SubdomainLabels {
	return { ...defaultSubdomainLabels(), ...overrides };
}

describe('self-host wizard hostname overrides', () => {
	describe('defaults unchanged when no overrides set', () => {
		it('deriveHostnames with no overrides matches the SUBDOMAINS defaults', () => {
			expect(deriveHostnames('wolves.ink')).toEqual({
				site: 'owlat.wolves.ink',
				convex: 'api.wolves.ink',
				convexSite: 'rest.api.wolves.ink',
				mail: 'mail.wolves.ink',
				bounce: 'bounce.wolves.ink',
			});
		});

		it('an empty override object is identical to passing nothing', () => {
			expect(deriveHostnames('wolves.ink', {})).toEqual(deriveHostnames('wolves.ink'));
		});

		it('blank / whitespace-only overrides fall back to the defaults (never a bare-dot host)', () => {
			const hosts = deriveHostnames('wolves.ink', { site: '', convex: '   ', mail: '\t' });
			expect(hosts).toEqual(deriveHostnames('wolves.ink'));
		});

		it('the default label set equals SUBDOMAINS and is a fresh copy each call', () => {
			expect(defaultSubdomainLabels()).toEqual({ ...SUBDOMAINS });
			expect(defaultSubdomainLabels()).not.toBe(defaultSubdomainLabels());
		});

		it('SUBDOMAIN_FIELDS covers exactly the five overridable labels, in order', () => {
			expect(SUBDOMAIN_FIELDS.map((f) => f.key)).toEqual(SUBDOMAIN_KEYS);
			expect(SUBDOMAIN_KEYS).toEqual(['site', 'convex', 'convexSite', 'mail', 'bounce']);
		});
	});

	describe('overridden labels propagate to hostnames, URLs and DNS instructions', () => {
		const overrides = withOverrides({
			site: 'app',
			convex: 'sync',
			convexSite: 'http.sync',
			mail: 'smtp',
			bounce: 'return',
		});

		it('overrides flow into every derived hostname', () => {
			expect(deriveHostnames('wolves.ink', overrides)).toEqual({
				site: 'app.wolves.ink',
				convex: 'sync.wolves.ink',
				convexSite: 'http.sync.wolves.ink',
				mail: 'smtp.wolves.ink',
				bounce: 'return.wolves.ink',
			});
		});

		it('a single override changes only its own hostname', () => {
			const hosts = deriveHostnames('wolves.ink', { site: 'app' });
			expect(hosts.site).toBe('app.wolves.ink');
			expect(hosts.convex).toBe('api.wolves.ink');
			expect(hosts.mail).toBe('mail.wolves.ink');
		});

		it('the network URLs derive from the overridden hostnames (one source of truth)', () => {
			const hosts = deriveHostnames('wolves.ink', overrides);
			expect(networkUrlsFromHosts(hosts)).toEqual({
				siteUrl: 'https://app.wolves.ink',
				convexUrl: 'https://sync.wolves.ink',
				convexSiteUrl: 'https://http.sync.wolves.ink',
			});
		});

		it('the DNS records reflect the overridden hostnames — A, MX, SPF and DMARC alike', () => {
			const hosts = deriveHostnames('wolves.ink', overrides);
			const rows = buildDnsRecords({ hosts, withMta: true, serverIp: '203.0.113.5' });
			const names = rows.map((r) => r.name);

			expect(names).toContain('app.wolves.ink');
			expect(names).toContain('sync.wolves.ink');
			expect(names).toContain('http.sync.wolves.ink');
			expect(names).toContain('smtp.wolves.ink');
			// The bounce host carries the MX/SPF; DMARC hangs off `_dmarc.<bounce>`.
			expect(
				rows.some(
					(r) => r.name === 'return.wolves.ink' && r.type === 'MX' && r.value === 'smtp.wolves.ink'
				)
			).toBe(true);
			expect(
				rows.some(
					(r) =>
						r.name === 'return.wolves.ink' &&
						r.type === 'TXT' &&
						r.value.includes('a:smtp.wolves.ink')
				)
			).toBe(true);
			expect(rows.some((r) => r.name === '_dmarc.return.wolves.ink')).toBe(true);

			// None of the original default hostnames leak through once overridden.
			for (const leaked of [
				'owlat.wolves.ink',
				'api.wolves.ink',
				'mail.wolves.ink',
				'bounce.wolves.ink',
			]) {
				expect(rows.some((r) => r.name === leaked || r.value === leaked)).toBe(false);
			}
		});

		it('dotted (`rest.api`-style) overrides expand as multi-label prefixes', () => {
			expect(deriveHostnames('x.io', { convexSite: 'edge.http' }).convexSite).toBe(
				'edge.http.x.io'
			);
		});
	});

	describe('label validation — invalid labels rejected', () => {
		it('accepts DNS-safe single and dotted labels', () => {
			for (const ok of ['owlat', 'api', 'rest.api', 'a', 'a1-b2', 'x'.repeat(63)]) {
				expect(validateSubdomainLabel(ok)).toBeNull();
			}
		});

		it('rejects empty / whitespace labels', () => {
			expect(validateSubdomainLabel('')).not.toBeNull();
			expect(validateSubdomainLabel('   ')).not.toBeNull();
		});

		it('rejects off-charset, hyphen-edge, over-length and empty-segment labels', () => {
			for (const bad of [
				'UPPER', // uppercase
				'has space',
				'under_score',
				'-lead', // leading hyphen
				'trail-', // trailing hyphen
				'a..b', // empty middle segment
				'rest.', // trailing dot → empty segment
				'.api', // leading dot → empty segment
				'a'.repeat(64), // segment too long
				'bad$char',
			]) {
				expect(validateSubdomainLabel(bad)).not.toBeNull();
			}
		});

		it('the whole-set validator flags the offending field and reports not-ok', () => {
			const result = validateSubdomainLabels(withOverrides({ site: 'Bad_Label' }));
			expect(result.ok).toBe(false);
			expect(result.errors.site).toBeTruthy();
			// The untouched fields stay clean.
			expect(result.errors.convex).toBeUndefined();
			expect(result.errors.mail).toBeUndefined();
		});

		it('the default label set passes validation', () => {
			expect(validateSubdomainLabels(defaultSubdomainLabels())).toEqual({ ok: true, errors: {} });
		});
	});

	describe('label validation — duplicate labels rejected', () => {
		it('rejects two labels sharing the same value and points at the collision', () => {
			const result = validateSubdomainLabels(withOverrides({ site: 'api' })); // collides with convex=api
			expect(result.ok).toBe(false);
			// The collision is reported on the later field (site comes before convex,
			// so convex is the one flagged) — the first occurrence stays clean.
			expect(result.errors.convex).toMatch(/distinct/i);
			expect(result.errors.site).toBeUndefined();
		});

		it('a malformed label is reported as malformed, not masked by a later duplicate check', () => {
			const result = validateSubdomainLabels(withOverrides({ site: 'BAD', convex: 'BAD' }));
			// Both are off-charset; each gets the charset error, not a duplicate error.
			expect(result.errors.site).toMatch(/lowercase/i);
			expect(result.errors.convex).toMatch(/lowercase/i);
		});

		it('distinct labels validate cleanly', () => {
			const result = validateSubdomainLabels(
				withOverrides({
					site: 'app',
					convex: 'sync',
					convexSite: 'http.sync',
					mail: 'smtp',
					bounce: 'return',
				})
			);
			expect(result).toEqual({ ok: true, errors: {} });
		});

		it('the collision message names the human field label, not the internal key', () => {
			const result = validateSubdomainLabels(withOverrides({ site: 'api' })); // collides with convex
			// It points at the earlier "App" (site) label — never the raw key.
			expect(result.errors.convex).toContain(`"${subdomainFieldLabel('site')}"`);
			expect(result.errors.convex).not.toContain('site');
		});
	});

	describe('validation scoped to the active labels', () => {
		it('ignores an inactive label — a clash with mail/bounce does not block a non-MTA install', () => {
			// site="mail" collides with the default mail label, but mail is inert here.
			const activeKeys = SUBDOMAIN_KEYS.filter((k) => k !== 'mail' && k !== 'bounce');
			const result = validateSubdomainLabels(withOverrides({ site: 'mail' }), activeKeys);
			expect(result.ok).toBe(true);
			expect(result.errors).toEqual({});
		});

		it('still flags the same clash when mail IS active (MTA install)', () => {
			const result = validateSubdomainLabels(withOverrides({ site: 'mail' }), SUBDOMAIN_KEYS);
			expect(result.ok).toBe(false);
			expect(result.errors.mail).toBeTruthy();
		});

		it('does not validate an inactive label that is itself malformed', () => {
			const activeKeys = SUBDOMAIN_KEYS.filter((k) => k !== 'mail' && k !== 'bounce');
			const result = validateSubdomainLabels(withOverrides({ mail: 'BAD_LABEL' }), activeKeys);
			expect(result.ok).toBe(true);
		});

		it('subdomainFieldLabel maps every key to its wizard label', () => {
			for (const f of SUBDOMAIN_FIELDS) {
				expect(subdomainFieldLabel(f.key)).toBe(f.label);
			}
		});
	});
});
