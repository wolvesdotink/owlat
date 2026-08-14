/**
 * DNS guidance, both layers — and especially the one no shipped kind reaches.
 *
 * All five incumbents carry a per-vendor override, so the CAPABILITY paragraph
 * is dead code until provider N+1 arrives; the first thing to exercise it would
 * otherwise be that provider, which is exactly the A3 scenario the plan wants
 * proven in advance. So the derivation takes an injected entry and this suite
 * drives a sixth kind through it.
 */
import { describe, expect, it } from 'vitest';
import { CORE_SEND_PROVIDER_CATALOG_ENTRIES } from '@owlat/shared/sendProviderCatalog';
import { capabilityDnsGuidance, transportDnsGuidance } from '../transportDnsGuidance';
import { createTestI18n } from '~/__tests__/i18n';

/**
 * Both layers hand back catalog keys, so the paragraphs are asserted as the
 * words the disclosure paints. A key the catalog does not carry renders as its
 * own path, which is why the shape checks compare against the key itself.
 */
const { t } = createTestI18n().global;

/** A provider that does not exist — the whole point of the exercise. */
const sixth = (domainVerification: 'api' | 'none') =>
	({
		kind: 'postmark',
		label: 'Postmark',
		tier: 'core' as const,
		retryDelays: [],
		requiredEnvVars: [],
		domainVerification,
	}) as const;

describe('the guidance every declared transport gets', () => {
	it.each(CORE_SEND_PROVIDER_CATALOG_ENTRIES.map((entry) => entry.kind))(
		'names %s and says something about its DNS',
		(kind) => {
			const guidance = transportDnsGuidance(kind);
			expect(guidance).not.toBeNull();
			expect(t(guidance!.label).length).toBeGreaterThan(0);
			expect(t(guidance!.lead)).not.toBe(guidance!.lead);
			expect(guidance!.points.length).toBeGreaterThan(0);
			for (const point of guidance!.points) expect(t(point)).not.toBe(point);
		}
	);

	it('says nothing for a transport this build does not carry', () => {
		expect(transportDnsGuidance('not-a-transport')).toBeNull();
		expect(transportDnsGuidance(null)).toBeNull();
	});
});

describe('a provider with no paragraph of its own', () => {
	it('is told about the identity API it declares', () => {
		const guidance = transportDnsGuidance('postmark', sixth('api'));
		expect(guidance).not.toBeNull();
		// Named from its catalog entry — no row anywhere in apps/web.
		expect(guidance!.label).toBe('Postmark');
		expect(t(guidance!.lead)).toContain('identity API');
		expect(guidance!.points.some((point) => t(point).includes('domain verification'))).toBe(true);
	});

	it('is told to follow its own setup guide when it verifies nothing', () => {
		const guidance = transportDnsGuidance('postmark', sixth('none'));
		expect(t(guidance!.lead)).toBe('Your provider handles SPF and DKIM for you.');
		expect(guidance!.points.some((point) => t(point).includes('SPF include'))).toBe(true);
	});

	it('never tells the OWN arm that "your provider" handles SPF for it', () => {
		// `tier: 'own'` is a branch of its own rather than a `domainVerification`
		// reading: our own MTA also declares `none`, and the relay sentence would
		// be actively wrong for the transport that IS you.
		const own = capabilityDnsGuidance({ tier: 'own', domainVerification: 'none' });
		expect(t(own.lead)).toBe('Owlat manages the DNS for you.');
		expect(own.points.some((point) => t(point).includes('managed records'))).toBe(true);
	});

	it('gives the own arm the same paragraph the mta entry used to spell out', () => {
		const mta = transportDnsGuidance('mta');
		expect(t(mta!.lead)).toBe('Owlat manages the DNS for you.');
	});
});
