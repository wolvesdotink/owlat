/**
 * `adaptive_mix` — THE ENQUEUE-TIME RECORD AND THE DISPATCH-TIME ROUTE AGREE.
 *
 * This is the property the whole measurement plane rests on, and the one that
 * cannot be asserted by testing either side alone. The assignment row says which
 * arm a recipient was assigned to; every rate the ramp controller reads — bounce,
 * complaint, engagement, placement — is a ratio over denominators taken from
 * those rows. If the worker then dispatches the recipient on a different
 * transport, the numbers are computed over an experiment that never ran, and
 * nothing throws, nothing logs, and no other test notices.
 *
 * So: record assignments for a whole audience through the real writer, then ask
 * the AUTHORITATIVE per-message resolver — the one the last-mile action
 * dispatches on — for each of those sends, and require the two to name the same
 * transport for every single recipient.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../../../../schema';
import { modules } from '../../../../__tests__/testModules';
import { sendProviderCatalogEntry } from '../../catalog';
import type { SendProviderKind } from '../../types';
import { resolveSendRouteFromDb } from '../../route';
import { recordSendAssignments } from '../../../../delivery/sendAssignments';
import { syntheticContactIds } from './fixtures';

// The authoritative resolver resolves the tenant the way production does, so
// the singleton lookup is stubbed to the same org the assignments are written
// under — otherwise the recorded rows and the replay would look at two tenants.
vi.mock('../../../sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../../sessionOrganization')>(
		'../../../sessionOrganization'
	);
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org-agreement') };
});

const ORG = 'org-agreement';
const AUDIENCE_SIZE = 300;

function stubTransportEnv(kind: SendProviderKind): void {
	for (const name of sendProviderCatalogEntry(kind).requiredEnvVars) {
		vi.stubEnv(name, name === 'MTA_API_URL' ? 'https://mta.test' : `test-${name.toLowerCase()}`);
	}
}

async function seedAdaptiveRoute(t: ReturnType<typeof convexTest>, ownShare: number) {
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert('providerRoutes', {
			messageType: 'campaign',
			strategy: 'adaptive_mix',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('deliverabilityRouteStates', {
			organizationId: ORG,
			destinationProvider: 'gmail',
			stream: 'campaign',
			isFallbackActive: false,
			ownShare,
			mixVersion: 11,
			signals: [],
			snapshotGeneratedAt: now,
			expiresAt: now + 600_000,
			updatedAt: now,
		});
	});
}

describe('adaptive_mix — enqueue-time record vs dispatch-time resolution', () => {
	beforeEach(() => {
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		stubTransportEnv('mta');
		stubTransportEnv('ses');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('dispatches every recipient on the transport its assignment row recorded', async () => {
		const t = convexTest(schema, modules);
		await seedAdaptiveRoute(t, 0.4);
		const contactIds = syntheticContactIds(AUDIENCE_SIZE, 'agree');
		const recipients = contactIds.map((contactId, index) => ({
			sendId: `send-agree-${index}`,
			email: `user${index}@gmail.com`,
			contactId,
			// Real scores, heavily tied: the stratified path is the default and
			// its rank is a property of the BATCH, which is exactly why dispatch
			// replays the record instead of re-deriving a decision.
			engagementScore: index < AUDIENCE_SIZE * 0.6 ? 0 : index % 30,
		}));
		await t.run(async (ctx) => {
			await recordSendAssignments(ctx, {
				organizationId: ORG,
				stream: 'campaign',
				sendKind: 'campaign',
				campaignId: 'cmp-agree',
				routing: { messageType: 'campaign', from: 'news@example.com' },
				recipients,
			});
		});

		const rows = await t.run(async (ctx) => await ctx.db.query('sendAssignments').collect());
		expect(rows.length).toBe(AUDIENCE_SIZE);
		// Both arms are actually populated — an all-one-arm fixture would make
		// the agreement assertion below vacuous.
		expect(rows.some((row) => row.arm === 'own')).toBe(true);
		expect(rows.some((row) => row.arm === 'reference')).toBe(true);

		const byEmail = new Map(recipients.map((recipient) => [recipient.sendId, recipient.email]));
		for (const row of rows) {
			const to = byEmail.get(row.sendId);
			expect(to).toBeDefined();
			const dispatched = await t.run(
				async (ctx) =>
					await resolveSendRouteFromDb(ctx, 'campaign', {
						to,
						from: 'news@example.com',
						sendId: row.sendId,
					})
			);
			expect(dispatched?.providerType).toBe(row.transport);
		}
	});

	it('still resolves a share-proportioned route for a send with no recorded row', async () => {
		// Recording is allowed to degrade — it must never fail a send — so the
		// resolver has to answer without a row. It decides from the same cell
		// share instead of falling through to "the first enabled provider".
		const t = convexTest(schema, modules);
		await seedAdaptiveRoute(t, 0.5);
		const providerTypes = new Set<string>();
		for (let index = 0; index < 60; index += 1) {
			const route = await t.run(
				async (ctx) =>
					await resolveSendRouteFromDb(ctx, 'campaign', {
						to: `nobody${index}@gmail.com`,
						from: 'news@example.com',
						sendId: `send-unrecorded-${index}`,
					})
			);
			expect(route).not.toBeNull();
			if (route) providerTypes.add(route.providerType);
		}
		expect(providerTypes).toEqual(new Set(['mta', 'ses']));
	});

	it('is stable: the same send resolves to the same transport every time', async () => {
		const t = convexTest(schema, modules);
		await seedAdaptiveRoute(t, 0.5);
		const resolveOnce = async () =>
			await t.run(
				async (ctx) =>
					await resolveSendRouteFromDb(ctx, 'campaign', {
						to: 'stable@gmail.com',
						from: 'news@example.com',
						sendId: 'send-stable',
					})
			);
		const first = await resolveOnce();
		for (let attempt = 0; attempt < 4; attempt += 1) {
			expect((await resolveOnce())?.providerType).toBe(first?.providerType);
		}
	});
});
