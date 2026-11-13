/**
 * A governed send asks the MTA to hold rather than ship unsigned exactly when
 * its From domain is a sending domain registered with the MTA, and the routing
 * query the send path already runs answers it.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import { isDkimSignatureRequired } from '../dkimSignatureRequirement';
import { resolveLastMileRoutePlanFromDb } from '../../lib/sendProviders/route';

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		mod,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

const NOW = Date.UTC(2026, 10, 13);

async function withDomain(row: {
	status: 'registering' | 'pending' | 'verified' | 'failed';
	providerType?: string;
	verifiedAt?: number;
}) {
	const t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		await ctx.db.insert('domains', {
			domain: 'example.org',
			dnsRecords: {},
			createdAt: NOW,
			updatedAt: NOW,
			...row,
		});
	});
	return t;
}

describe('isDkimSignatureRequired', () => {
	it('requires a signature for a verified domain the MTA signs', async () => {
		const t = await withDomain({ status: 'verified', providerType: 'mta', verifiedAt: NOW });
		expect(await t.run((ctx) => isDkimSignatureRequired(ctx, 'Owlat <news@example.org>'))).toBe(
			true
		);
	});

	it.each(['registering', 'pending', 'failed'] as const)(
		'keeps requiring it while a regenerated domain is %s again',
		async (status) => {
			const t = await withDomain({ status, providerType: 'mta' });
			expect(await t.run((ctx) => isDkimSignatureRequired(ctx, 'news@example.org'))).toBe(true);
		}
	);

	it('does not require one for a domain a relay signs', async () => {
		const t = await withDomain({ status: 'verified', providerType: 'ses', verifiedAt: NOW });
		expect(await t.run((ctx) => isDkimSignatureRequired(ctx, 'news@example.org'))).toBe(false);
	});

	it('does not require one for a From domain that is not registered', async () => {
		const t = await withDomain({ status: 'verified', providerType: 'mta', verifiedAt: NOW });
		expect(await t.run((ctx) => isDkimSignatureRequired(ctx, 'news@other.example'))).toBe(false);
	});

	it('is answered by the last-mile routing plan', async () => {
		const t = await withDomain({ status: 'verified', providerType: 'mta', verifiedAt: NOW });
		const plan = await t.run((ctx) =>
			resolveLastMileRoutePlanFromDb(ctx, 'campaign', {
				to: 'person@gmail.com',
				from: 'news@example.org',
				now: NOW,
			})
		);
		expect(plan.requireDkimSignature).toBe(true);
	});
});
