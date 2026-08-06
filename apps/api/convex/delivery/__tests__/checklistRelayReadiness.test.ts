/**
 * THE DEPLOYMENT-RELAY CHECKLIST ITEM ASKS A CAPABILITY (the seams plan's P0.4).
 *
 * `deployment.relay` used to require `relayProviderType === 'ses'` and an
 * enabled `'ses'` entry on the route. That was true of the gate above it at the
 * time — `setRoute` refused every other relay — and became false the moment P0.2
 * turned fallback eligibility into a catalog question. From then on a deployment
 * relaying through Mandrill (or a bring-your-own SMTP relay) had a fallback
 * configured, identities provisioned, and a readiness item that reported "No
 * verified relay fallback is configured" forever, with nothing on the screen
 * explaining why.
 *
 * Differential in both directions: the SES cases pin that the shipped verdict is
 * byte-identical, and the non-SES cases are unsatisfiable by an `=== 'ses'`
 * gate. The fail-closed cases matter as much — `relayProviderType` is a
 * free-form string on the route row, so the predicate has to refuse our own MTA
 * (the arm a fallback moves traffic AWAY from) and any kind this deployment
 * cannot actually send through.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../checklistProviderDetection', () => ({
	detectIpProvider: vi.fn(async () => null),
}));

import { observeDeploymentCheck } from '../checklistDeploymentValidators';
import type { ChecklistVerificationContext } from '../checklistValidatorTypes';

const NOW = Date.now();

function route(
	relayProviderType: string,
	enabledKinds: readonly string[],
	isEnabled = true
): ChecklistVerificationContext['routes'][number] {
	return {
		_id: 'route-1' as ChecklistVerificationContext['routes'][number]['_id'],
		_creationTime: NOW,
		messageType: 'transactional',
		strategy: 'single',
		providers: enabledKinds.map((providerType) => ({ providerType, isEnabled: true })),
		deliverabilityFallback: { isEnabled, relayProviderType, isWarmupOverflowEnabled: false },
		createdAt: NOW,
		updatedAt: NOW,
	} as ChecklistVerificationContext['routes'][number];
}

/**
 * One fresh, fully proven relay identity. The identity half of the item is
 * unchanged by this piece — it still reads the frozen SES sibling rows the
 * verification context carries — so every case here holds it constant and varies
 * only the ROUTE.
 */
function provenIdentity(): ChecklistVerificationContext['relayIdentities'][number] {
	return {
		_id: 'identity-1',
		_creationTime: NOW,
		domainId: 'domain-1',
		isProviderVerified: true,
		verifiedAt: NOW - 1_000,
		spfProofState: 'not_applicable_manual_primary',
	} as unknown as ChecklistVerificationContext['relayIdentities'][number];
}

function context(
	routes: ChecklistVerificationContext['routes'],
	relayIdentities: ChecklistVerificationContext['relayIdentities'] = [provenIdentity()]
): ChecklistVerificationContext {
	return {
		domain: null,
		settings: null,
		warming: null,
		routes,
		relayIdentities,
		tracking: [],
		postmaster: null,
	};
}

const observe = async (
	ctx: ChecklistVerificationContext
): Promise<{ status: string; diagnostic: string }> => {
	const observation = await observeDeploymentCheck('deployment.relay', ctx, false);
	return { status: observation.status, diagnostic: observation.diagnostic };
};

function configureSes(): void {
	vi.stubEnv('AWS_SES_REGION', 'eu-central-1');
	vi.stubEnv('AWS_SES_ACCESS_KEY_ID', 'AKIA-test');
	vi.stubEnv('AWS_SES_SECRET_ACCESS_KEY', 'secret');
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('deployment.relay readiness — the shipped SES verdict is unchanged', () => {
	it('passes for a configured, enabled SES fallback with a current proof', async () => {
		configureSes();
		expect(await observe(context([route('ses', ['mta', 'ses'])]))).toEqual({
			status: 'pass',
			diagnostic:
				'The deliverability fallback relay is enabled and every relay identity has a current provider and SPF proof.',
		});
	});

	it('warns when the SES route is ready but a domain proof is stale', async () => {
		configureSes();
		const stale = {
			...provenIdentity(),
			verifiedAt: NOW - 400 * 24 * 60 * 60 * 1000,
		} as ChecklistVerificationContext['relayIdentities'][number];
		expect(await observe(context([route('ses', ['mta', 'ses'])], [stale]))).toEqual({
			status: 'warn',
			diagnostic:
				'The deliverability fallback relay is enabled, but at least one domain proof is absent or stale.',
		});
	});

	it('warns when the fallback is switched off', async () => {
		configureSes();
		expect(await observe(context([route('ses', ['mta', 'ses'], false)]))).toEqual({
			status: 'warn',
			diagnostic: 'No verified relay fallback is configured.',
		});
	});
});

describe('deployment.relay readiness — every eligible relay counts, not just SES', () => {
	it.each([
		['mandrill', ['MANDRILL_API_KEY']],
		['resend', ['RESEND_API_KEY']],
	])(
		'passes for a configured, enabled %s fallback the old gate could never see',
		async (kind, envKeys) => {
			// THE DIFFERENTIAL CASE. Neither kind is `ses`, so the shipped
			// `relayProviderType === 'ses'` gate made this expectation unsatisfiable:
			// the item reported "No verified relay fallback is configured" for a
			// deployment whose fallback was configured, enabled and proven.
			for (const key of envKeys) vi.stubEnv(key, 'configured');
			expect(await observe(context([route(kind, ['mta', kind])]))).toEqual({
				status: 'pass',
				diagnostic:
					'The deliverability fallback relay is enabled and every relay identity has a current provider and SPF proof.',
			});
		}
	);

	it('names no provider in any of its three verdicts', async () => {
		// The copy is what an operator reads, and it used to say "The SES fallback
		// route" under a gate that no longer means SES. Pinned against the CATALOG's
		// own vocabulary rather than a hand-written list, so a sixth kind cannot be
		// smuggled into the copy either.
		configureSes();
		const diagnostics = [
			(await observe(context([route('ses', ['mta', 'ses'])]))).diagnostic,
			(await observe(context([route('ses', ['mta', 'ses'])], []))).diagnostic,
			(await observe(context([]))).diagnostic,
		];
		const { SEND_PROVIDER_CATALOG } = await import('../../lib/sendProviders/catalog');
		for (const diagnostic of diagnostics) {
			for (const entry of SEND_PROVIDER_CATALOG) {
				expect(diagnostic.toLowerCase()).not.toContain(entry.kind.toLowerCase());
				expect(diagnostic.toLowerCase()).not.toContain(entry.label.toLowerCase());
			}
		}
	});
});

describe('deployment.relay readiness — fail closed on what it cannot vouch for', () => {
	it('refuses a fallback that names our own MTA', async () => {
		// D3's one sanctioned identity, read through `isFallbackRelayEligible`: the
		// MTA is the arm a fallback moves traffic away from. A route row naming it
		// would otherwise match an enabled `mta` entry — which every deployment has
		// — and report a relay that does not exist as ready.
		vi.stubEnv('MTA_API_URL', 'https://mta.test/');
		vi.stubEnv('MTA_API_KEY', 'test-key');
		expect(await observe(context([route('mta', ['mta'])]))).toEqual({
			status: 'warn',
			diagnostic: 'No verified relay fallback is configured.',
		});
	});

	it('refuses a relay kind this deployment has no credentials for', async () => {
		// No `MANDRILL_API_KEY`. A relay whose credentials are absent is not a
		// fallback, it is a second outage — the same reading `resolveRoute` gates on.
		expect(await observe(context([route('mandrill', ['mta', 'mandrill'])]))).toEqual({
			status: 'warn',
			diagnostic: 'No verified relay fallback is configured.',
		});
	});

	it('refuses a relay kind no longer in the catalog', async () => {
		expect(await observe(context([route('postmark', ['mta', 'postmark'])]))).toEqual({
			status: 'warn',
			diagnostic: 'No verified relay fallback is configured.',
		});
	});

	it('refuses an eligible relay that is not an enabled entry on the route', async () => {
		// The relay must ALSO be a live provider on the route it is the fallback
		// for — the pairing `setRoute` enforces at save time. Read against whichever
		// kind the fallback named, so it is the same rule for every kind.
		configureSes();
		expect(await observe(context([route('ses', ['mta'])]))).toEqual({
			status: 'warn',
			diagnostic: 'No verified relay fallback is configured.',
		});
	});
});
