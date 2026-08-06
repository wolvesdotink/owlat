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
 * (the arm a fallback moves traffic AWAY from), any kind this deployment cannot
 * actually send through, and any route shape `setRoute` would refuse to save.
 *
 * The ROUTE half is what became kind-agnostic. The PROOF half still reads one
 * kind's sibling rows, so the item credits them only to that kind — a relay
 * whose proofs this deployment cannot yet read reports the proof missing, never
 * another provider's proof as its own.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../checklistProviderDetection', () => ({
	detectIpProvider: vi.fn(async () => null),
}));

import { observeDeploymentCheck } from '../checklistDeploymentValidators';
import {
	RELAY_IDENTITY_PROOF_KIND,
	type ChecklistVerificationContext,
} from '../checklistValidatorTypes';

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
 * One fresh, fully proven relay identity, in the frozen SES sibling shape the
 * verification context carries — i.e. a proof of exactly ONE kind's identity
 * ({@link RELAY_IDENTITY_PROOF_KIND}). The cases below hold it constant and vary
 * the ROUTE, so a verdict that changes with the configured relay changed because
 * of the route and not because of the proof.
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
		'sees the route half of a configured, enabled %s fallback the old gate could never see',
		async (kind, envKeys) => {
			// THE DIFFERENTIAL CASE. Neither kind is `ses`, so the shipped
			// `relayProviderType === 'ses'` gate made this expectation unsatisfiable:
			// the item reported "No verified relay fallback is configured" for a
			// deployment whose fallback was configured and enabled, with nothing on
			// the screen explaining why.
			//
			// It reports the PROOF as missing, not the route — the honest verdict
			// while the identity half can still only read one kind's sibling rows
			// (see the leftover-rows case below for why that half must not be
			// credited to another kind).
			for (const key of envKeys) vi.stubEnv(key, 'configured');
			expect(await observe(context([route(kind, ['mta', kind])]))).toEqual({
				status: 'warn',
				diagnostic:
					'The deliverability fallback relay is enabled, but at least one domain proof is absent or stale.',
			});
		}
	);

	it('does not let another kind’s leftover identity rows prove this relay', async () => {
		// A deployment that switches its fallback from SES to Mandrill KEEPS its SES
		// sibling rows — nothing deletes them on a switch, and `verifyDomain` goes on
		// refreshing them, so `isProviderVerified`/`verifiedAt` stay current forever.
		// Crediting them would report `pass` ("every relay identity has a current
		// provider and SPF proof") for a relay that holds ZERO identities and refuses
		// every domain the moment the breaker opens. The proof rows belong to one
		// kind; only that kind may be proven by them.
		vi.stubEnv('MANDRILL_API_KEY', 'configured');
		configureSes();
		expect(
			await observe(context([route('mandrill', ['mta', 'mandrill'])], [provenIdentity()]))
		).toEqual({
			status: 'warn',
			diagnostic:
				'The deliverability fallback relay is enabled, but at least one domain proof is absent or stale.',
		});
		// A MIXED deployment — one message type relaying through the kind these
		// rows prove, another through a kind they say nothing about — is the same
		// question asked twice, and one answer must not cover the other.
		expect(
			await observe(
				context([
					route(RELAY_IDENTITY_PROOF_KIND, ['mta', RELAY_IDENTITY_PROOF_KIND]),
					route('mandrill', ['mta', 'mandrill']),
				])
			)
		).toEqual({
			status: 'warn',
			diagnostic:
				'The deliverability fallback relay is enabled, but at least one domain proof is absent or stale.',
		});
		// Same rows, same everything — only the configured relay differs.
		expect(
			await observe(
				context(
					[route(RELAY_IDENTITY_PROOF_KIND, ['mta', RELAY_IDENTITY_PROOF_KIND])],
					[provenIdentity()]
				)
			)
		).toEqual({
			status: 'pass',
			diagnostic:
				'The deliverability fallback relay is enabled and every relay identity has a current provider and SPF proof.',
		});
	});

	it('names no provider in any of its three verdicts, nor in the action it hands the operator', async () => {
		// The copy is what an operator reads, and it used to say "The SES fallback
		// route" under a gate that no longer means SES — as did the remediation line
		// rendered beside it (`DELIVERABILITY_NEXT_ACTIONS`, via
		// `delivery/checklist.ts` and `checklistGuidance.ts`), which is the half that
		// tells a Mandrill deployment what to do next. Both are pinned here so they
		// cannot separate again, and against the CATALOG's own vocabulary rather than
		// a hand-written list, so a sixth kind cannot be smuggled into either.
		configureSes();
		const { DELIVERABILITY_NEXT_ACTIONS } = await import('@owlat/shared');
		const copy = [
			(await observe(context([route('ses', ['mta', 'ses'])]))).diagnostic,
			(await observe(context([route('ses', ['mta', 'ses'])], []))).diagnostic,
			(await observe(context([]))).diagnostic,
			DELIVERABILITY_NEXT_ACTIONS['deployment.relay'],
		];
		const { SEND_PROVIDER_CATALOG } = await import('../../lib/sendProviders/catalog');
		for (const line of copy) {
			for (const entry of SEND_PROVIDER_CATALOG) {
				expect(line.toLowerCase()).not.toContain(entry.kind.toLowerCase());
				expect(line.toLowerCase()).not.toContain(entry.label.toLowerCase());
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
		// for — `routeCarriesEnabledRelay`, the same function `setRoute` throws on
		// at save time rather than a second copy of the rule. Read against whichever
		// kind the fallback named, so it is the same rule for every kind.
		configureSes();
		expect(await observe(context([route('ses', ['mta'])]))).toEqual({
			status: 'warn',
			diagnostic: 'No verified relay fallback is configured.',
		});
	});

	it('refuses a fallback on a route carrying no own-MTA arm', async () => {
		// `routeCarriesOwnArm`, again the function `setRoute` throws on: a
		// deliverability fallback is traffic leaving our own infrastructure, so a
		// route with no enabled own arm has nothing to fall back FROM. Asking the
		// same three predicates the mutation asks is what stops this item reporting
		// a route as ready that the mutation refuses to save (or the reverse, once
		// the save-time rules move).
		configureSes();
		expect(await observe(context([route('ses', ['ses'])]))).toEqual({
			status: 'warn',
			diagnostic: 'No verified relay fallback is configured.',
		});
	});
});
