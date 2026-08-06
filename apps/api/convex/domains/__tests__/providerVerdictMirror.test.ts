/**
 * THE PROVIDER-VERDICT MIRROR IS A CAPABILITY (the seams plan's P0.4).
 *
 * `verifyDomain` runs the DNS lookups, then asks the domain's provider for its
 * own verdict (`runProviderCheck`), then mirrors that verdict into
 * `verificationResults` so the domain-records screen can show it beside the DNS
 * rows. The mirror used to be guarded by `domain.providerType === 'ses'` with the
 * SES field name and the 'Success'/'Pending' spelling written out in the
 * verifier — so "does this provider have a verdict worth showing?" was a question
 * about a NAME, and a kind that shipped one had to edit the verifier to be
 * allowed to answer.
 *
 * It is now `verificationStatusFields` on the adapter contract. The differential
 * case below drives a MOCK KIND whose adapter returns a projection the old
 * `=== 'ses'` branch would have thrown away, and whose value deliberately
 * contradicts the `verified ? 'Success' : 'Pending'` rule the verifier used to
 * own — so a verifier that kept either half of the old code fails it.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { sesProvider } from '../providers/ses';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../lib/sessionOrganization')>(
		'../../lib/sessionOrganization'
	);
	const ctx = () => ({ userId: 'test-user', role: 'owner' as const });
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ctx()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn(async () => ctx()),
		requireOrgPermission: vi.fn(async () => ctx()),
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org-a'),
	};
});

vi.mock('node:dns/promises', () => ({
	default: {
		resolveTxt: vi.fn().mockRejectedValue(new Error('no txt')),
		resolveMx: vi.fn().mockRejectedValue(new Error('no mx')),
		resolveCname: vi.fn().mockRejectedValue(new Error('no cname')),
		resolve: vi.fn().mockRejectedValue(new Error('no record')),
		resolve4: vi.fn().mockRejectedValue(new Error('no a')),
		reverse: vi.fn().mockRejectedValue(new Error('no ptr')),
	},
}));

/**
 * A provider kind that is not `ses` and DOES declare a status projection, plus
 * one that declares a check with no projection at all. Between them they cover
 * both directions of the capability: the verifier writes what the adapter says,
 * and writes nothing where the adapter says nothing.
 */
const MOCK_TELLING_KIND = 'mock-telling';
const MOCK_SILENT_KIND = 'mock-silent';

/**
 * Deliberately NOT `verified ? 'Success' : 'Pending'`. The verifier used to own
 * that spelling, so a value it cannot possibly have produced is what proves the
 * string came from the adapter.
 */
const MOCK_STATUS = 'MockVerified';

vi.mock('../providers', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../providers')>();
	const overrides: Record<string, unknown> = {
		[MOCK_TELLING_KIND]: {
			kind: MOCK_TELLING_KIND,
			runProviderCheck: async () => ({ verified: true }),
			verificationStatusFields: () => ({ sesStatus: MOCK_STATUS }),
		},
		[MOCK_SILENT_KIND]: {
			kind: MOCK_SILENT_KIND,
			runProviderCheck: async () => ({ verified: true }),
		},
	};
	return {
		...actual,
		isSendingDomainProviderKind: (kind: string | undefined | null) =>
			(typeof kind === 'string' && Object.prototype.hasOwnProperty.call(overrides, kind)) ||
			actual.isSendingDomainProviderKind(kind),
		providerFor: (kind: string) =>
			Object.prototype.hasOwnProperty.call(overrides, kind)
				? overrides[kind]
				: actual.providerFor(kind as Parameters<typeof actual.providerFor>[0]),
	};
});

const modules = {
	...import.meta.glob('../../**/*.*s'),
	...Object.fromEntries(
		Object.entries(import.meta.glob('../**/*.*s')).map(([p, m]) => [
			p.replace(/^\.\.\//, '../../domains/'),
			m,
		])
	),
};

type TestConvex = ReturnType<typeof convexTest>;

async function verifiedDomainResults(
	t: TestConvex,
	providerType: string
): Promise<Record<string, unknown>> {
	const domainId = await t.run(async (ctx) =>
		ctx.db.insert('domains', {
			domain: 'mirror.example.com',
			status: 'pending',
			providerType,
			// Empty bundle: this suite is about the PROVIDER verdict, and an empty
			// record set keeps the DNS half from deciding anything.
			dnsRecords: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	);
	const result = await t.action(api.domains.dnsVerification.verifyDomain, { domainId });
	return result.results as unknown as Record<string, unknown>;
}

beforeEach(() => {
	vi.stubEnv('EMAIL_PROVIDER', 'mta');
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('verifyDomain mirrors whatever verdict the ADAPTER projects', () => {
	it('writes a non-SES provider status the old identity branch discarded', async () => {
		// THE DIFFERENTIAL CASE, in both halves: the kind is not `ses` (so the old
		// branch wrote nothing) and the value is not the verifier's old
		// `verified ? 'Success' : 'Pending'` rule (so a verifier that kept that rule
		// and merely widened the guard writes 'Success' and fails here).
		const t = convexTest(schema, modules);
		expect(await verifiedDomainResults(t, MOCK_TELLING_KIND)).toMatchObject({
			sesStatus: MOCK_STATUS,
		});
	});

	it('writes nothing for a provider that has a check but no status to show', async () => {
		// Absence is a real answer. Our own MTA is the shipped example: it has no
		// provider verdict at all, and a mirror it never asked for would put a
		// meaningless pill on its records screen.
		const t = convexTest(schema, modules);
		expect(await verifiedDomainResults(t, MOCK_SILENT_KIND)).not.toHaveProperty('sesStatus');
	});

	it('writes nothing for a provider with no verdict of its own', async () => {
		const t = convexTest(schema, modules);
		expect(await verifiedDomainResults(t, 'mta')).not.toHaveProperty('sesStatus');
	});
});

describe('the SES spelling is unchanged and stated once', () => {
	it.each([
		[true, 'Success'],
		[false, 'Pending'],
	])('projects a %s SES check as %s', (verified, expected) => {
		// Byte-identical to the two lines the verifier used to carry, now the one
		// place that spelling exists — `domains/sesRelayVerification.ts` asks the
		// same adapter rather than repeating it.
		// Non-null asserted, not guarded: the SES adapter declaring this method is
		// itself part of what this suite pins (the capability table below), so an
		// adapter that dropped it must fail here rather than skip the case.
		expect(sesProvider.verificationStatusFields!({ verified })).toEqual({ sesStatus: expected });
	});

	it('is declared by exactly the shipped adapters that have a pill to show', async () => {
		// One table rather than a case per adapter. Mandrill HAS a provider verdict
		// (`check-domain`) and still declares nothing here on purpose: its state is
		// rendered on its own relay panel from the generic identity row, and
		// borrowing SES's field would put an SES-labelled pill on a Mandrill domain.
		const { SENDING_DOMAIN_PROVIDERS } = await import('../providers');
		const declared = Object.fromEntries(
			Object.entries(SENDING_DOMAIN_PROVIDERS).map(([kind, provider]) => [
				kind,
				typeof (provider as { verificationStatusFields?: unknown }).verificationStatusFields ===
					'function',
			])
		);
		expect(declared).toEqual({ mta: false, ses: true, mandrill: false });
	});
});
