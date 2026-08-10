/**
 * `delivery.observabilityStatus.get` — the admin delivery hub's measurement tile.
 *
 * What this file pins:
 *
 *   - the ADMIN FLOOR is real: an anonymous caller and an editor member are both
 *     refused before a seed row or an SNDS row is read;
 *   - the read is ORG-SCOPED: another organization's seed mailboxes are never
 *     counted, even though the handler no longer derives the org id itself at
 *     all — it takes the one the floor admitted;
 *   - the permission gate runs ONCE per execution, and NOTHING else looks a
 *     session up. The handler used to call `requireOrgPermission` again purely to
 *     obtain `activeOrganizationId` (two BetterAuth session + `member`
 *     resolutions on a query the hub live-subscribes and every seed /
 *     `sndsIpDailyStats` write invalidates), then `getBetterAuthSession` for the
 *     cheaper claim read. `adminQuery` threads its own resolved session in, so
 *     both extra reads are gone and the count is 1 + 0;
 *   - the org scope can never be silently dropped: a session with no active
 *     organization is refused by the floor rather than read cross-tenant.
 *
 * The session helpers are mocked because convex-test has no BetterAuth identity
 * and no BetterAuth component — the shipped pattern from
 * `analytics/__tests__/seedHygiene.test.ts`. `requireOrgPermission` keeps the
 * real gate's decisions (via the real `hasPermission` table) and its CALL COUNT
 * is what the regression assertion reads.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { insertExternalAccountRow } from '../../mail/externalAccountShared';
import { modules } from '../../__tests__/testModules';
import { SEED_ROTATION_INTERVAL_MS } from '@owlat/shared/seedPlacement';
import {
	getBetterAuthSession,
	requireOrgPermission,
	type OrganizationRole,
	type Permission,
} from '../../lib/sessionOrganization';

const ORG = 'org_observability';
const OTHER_ORG = 'org_intruder';
const NOW = new Date('2026-07-15T12:00:00.000Z').getTime();

const session = vi.hoisted(() => ({
	/** Is there a session at all? */
	present: true,
	role: 'owner' as OrganizationRole,
	/** The active org the gate resolves — and threads into the handler. */
	organizationId: 'org_observability' as string | null,
}));

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return {
		...actual,
		requireOrgPermission: vi.fn(async (_ctx: unknown, permission: Permission) => {
			if (!session.present) throw new Error('Not authenticated');
			// The floor's own order: no active organization is refused BEFORE the role
			// is weighed, exactly as `requireOrgPermission` does it.
			if (!session.organizationId) {
				throw new Error('No active organization. Please select an organization.');
			}
			if (!actual.hasPermission(session.role, permission)) {
				throw new Error("You don't have permission to perform this action");
			}
			return {
				userId: 'admin-1',
				role: session.role,
				activeOrganizationId: session.organizationId,
			};
		}),
		// Mocked but expected NEVER to run: the handler used to reach for the JWT
		// claim to re-derive the org id, and the count assertion below is what keeps
		// it from creeping back.
		getBetterAuthSession: vi.fn(async () =>
			session.present ? { userId: 'admin-1', activeOrganizationId: session.organizationId } : null
		),
	};
});

const CREDS = {
	imapHost: 'imap.example.com',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.example.com',
	smtpPort: 587,
	isSmtpSecure: false,
	imapUsername: 'seed-login',
	authMethod: 'password' as const,
	secretCiphertext: 'ct',
	secretIv: 'iv',
	secretAuthTag: 'tag',
	secretEnvelopeVersion: 1,
};

async function connectSeed(
	t: ReturnType<typeof convexTest>,
	options: { organizationId?: string; address?: string; connectedAt?: number } = {}
): Promise<void> {
	const organizationId = options.organizationId ?? ORG;
	const address = options.address ?? 'owlat.seed.01@outlook.example';
	const connectedAt = options.connectedAt ?? NOW;
	await t.run(async (ctx) => {
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user_1',
			organizationId,
			address,
			domain: 'outlook.example',
			kind: 'external' as const,
			status: 'active' as const,
			usedBytes: 0,
			uidValidity: connectedAt,
			createdAt: connectedAt,
			updatedAt: connectedAt,
		});
		await insertExternalAccountRow(ctx, {
			userId: 'user_1',
			organizationId,
			mailboxId,
			address,
			seed: { seedProvider: 'microsoft' },
			fields: CREDS,
			now: connectedAt,
		});
	});
}

beforeEach(() => {
	session.present = true;
	session.role = 'owner';
	session.organizationId = ORG;
	// Call COUNTS are asserted below; `mockClear` keeps the factory
	// implementations above.
	vi.clearAllMocks();
	// ONLY the clock: the rotation nudge is a `now - connectedAt` decision, and
	// faking scheduling as well would stall convex-test's own async machinery.
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	return () => {
		vi.unstubAllEnvs();
		vi.useRealTimers();
	};
});

describe('observabilityStatus.get — the admin floor', () => {
	it('refuses an anonymous caller', async () => {
		const t = convexTest(schema, modules);
		session.present = false;
		await expect(t.query(api.delivery.observabilityStatus.get, {})).rejects.toThrow(
			/Not authenticated/
		);
	});

	it('refuses an editor member', async () => {
		const t = convexTest(schema, modules);
		session.role = 'editor';
		await connectSeed(t);
		await expect(t.query(api.delivery.observabilityStatus.get, {})).rejects.toThrow(/permission/i);
	});

	it('refuses a session with no active organization', async () => {
		const t = convexTest(schema, modules);
		session.organizationId = null;
		await connectSeed(t);
		await expect(t.query(api.delivery.observabilityStatus.get, {})).rejects.toThrow(
			/active organization/i
		);
	});
});

describe('observabilityStatus.get — the status it reports', () => {
	it('counts only the active organization’s seed mailboxes', async () => {
		const t = convexTest(schema, modules);
		await connectSeed(t, { address: 'owlat.seed.01@outlook.example' });
		await connectSeed(t, { address: 'owlat.seed.02@outlook.example' });
		await connectSeed(t, { organizationId: OTHER_ORG, address: 'intruder.seed@outlook.example' });

		const status = await t.query(api.delivery.observabilityStatus.get, {});
		expect(status.seedMailboxes).toEqual({ connected: 2, rotationRemindersDue: 0 });
	});

	it('surfaces a seed whose rotation is due', async () => {
		const t = convexTest(schema, modules);
		await connectSeed(t, { connectedAt: NOW - SEED_ROTATION_INTERVAL_MS - 1 });

		const status = await t.query(api.delivery.observabilityStatus.get, {});
		expect(status.seedMailboxes).toEqual({ connected: 1, rotationRemindersDue: 1 });
	});

	it('reports the SNDS feed count and last observation without leaking a feed URL', async () => {
		const t = convexTest(schema, modules);
		vi.stubEnv(
			'SNDS_DATA_FEED_URLS',
			'https://sndsapi.microsoft.com/data.aspx?key=secret-one,https://sndsapi.microsoft.com/data.aspx?key=secret-two'
		);
		await t.run(async (ctx) => {
			await ctx.db.insert('sndsIpDailyStats', {
				ip: '198.51.100.7',
				periodStart: NOW - 86_400_000,
				complaintBand: 'lt_0_1',
				filterResult: 'green',
				trapHits: 0,
				messageRecipients: 10,
				rcptCommands: 10,
				dataCommands: 10,
				fetchedAt: NOW - 1_000,
				ingestedAt: NOW - 500,
			});
		});

		const status = await t.query(api.delivery.observabilityStatus.get, {});
		expect(status.microsoftFeedback).toEqual({
			configured: true,
			feedCount: 2,
			lastObservedAt: NOW - 1_000,
		});
		expect(JSON.stringify(status)).not.toContain('secret-one');
	});

	it('runs the permission gate once — the org scope costs no second resolution', async () => {
		const t = convexTest(schema, modules);
		await connectSeed(t);

		await t.query(api.delivery.observabilityStatus.get, {});

		// Once, in the `adminQuery` floor…
		expect(vi.mocked(requireOrgPermission)).toHaveBeenCalledTimes(1);
		// …and NOT AT ALL in the handler: the org scope is the floor's own resolved
		// session, threaded in, so not even the cheap JWT-claim read remains.
		expect(vi.mocked(getBetterAuthSession)).not.toHaveBeenCalled();
	});
});
