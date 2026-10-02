/**
 * The IMAP server registry (ADR-0063): the handshake upsert and its verdicts,
 * the operator status (window, legacy logins, `safeToRaiseMinTo`), legacy
 * detection through `appPasswords.touch`, the platform-admin read and the
 * daily prune.
 *
 * The wire constants are mocked to a backend that has moved on (speaks 3,
 * serves 2 and newer), so every verdict, `unsupported` included, is reachable.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModulesWithoutNodeActions';
import type * as ImapWire from '@owlat/shared/imapWire';

const wire = vi.hoisted(() => ({ version: 3, min: 2 }));

vi.mock('@owlat/shared/imapWire', async (importOriginal) => {
	const actual = await importOriginal<typeof ImapWire>();
	return {
		...actual,
		get IMAP_WIRE_VERSION() {
			return wire.version;
		},
		get IMAP_WIRE_MIN_SUPPORTED() {
			return wire.min;
		},
	};
});

const caller = vi.hoisted(() => ({ subject: 'admin-user' }));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'admin-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockImplementation(async () => caller.subject),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'admin-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi.fn().mockImplementation(async () => ({
			subject: caller.subject,
			issuer: 'test',
			tokenIdentifier: `test|${caller.subject}`,
		})),
	};
});

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1, 12);

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T0);
	caller.subject = 'admin-user';
});

afterEach(() => {
	vi.useRealTimers();
});

const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

function reportArgs(overrides: Partial<{ wireVersion: number; owlatVersion: string }> = {}) {
	return {
		instanceId: 'proc-1',
		hostLabel: 'a1b2c3d4e5f6',
		owlatVersion: '0.6.9',
		wireVersion: 3,
		startedAt: T0 - 1000,
		...overrides,
	};
}

async function seedServer(
	t: T,
	row: { hostLabel: string; owlatVersion: string; wireVersion: number; lastSeenAt: number }
) {
	await t.run((ctx) =>
		ctx.db.insert('imapServers', { instanceId: 'seed', startedAt: row.lastSeenAt, ...row })
	);
}

async function seedCredential(t: T) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user-1',
			organizationId: 'org-1',
			address: 'alice@example.com',
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		return await ctx.db.insert('mailAppPasswords', {
			mailboxId,
			userId: 'user-1',
			label: 'phone',
			passwordHash: 'aa:bb',
			passwordPrefix: 'abcd',
			scopes: ['imap', 'smtp'],
			createdAt: now,
		});
	});
}

const legacySeenAt = (t: T) =>
	t.run(async (ctx) => {
		const row = await ctx.db
			.query('instanceCounters')
			.withIndex('by_key', (q) => q.eq('key', 'imapLegacy'))
			.first();
		return row?.legacyImapSeenAt ?? null;
	});

describe('serverRegistry.report', () => {
	it('records the server and answers with the backend contract', async () => {
		const t = harness();
		const result = await t.mutation(internal.mail.imap.serverRegistry.report, reportArgs());
		expect(result).toEqual({ backendWireVersion: 3, minSupportedWireVersion: 2, compatible: true });

		const rows = await t.run((ctx) => ctx.db.query('imapServers').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			instanceId: 'proc-1',
			hostLabel: 'a1b2c3d4e5f6',
			owlatVersion: '0.6.9',
			wireVersion: 3,
			lastSeenAt: T0,
		});
	});

	it('updates one row per host and build across reports and restarts', async () => {
		const t = harness();
		await t.mutation(internal.mail.imap.serverRegistry.report, reportArgs());
		vi.setSystemTime(T0 + 5 * 60_000);
		await t.mutation(internal.mail.imap.serverRegistry.report, reportArgs());
		// The container restarted: a new process, same host and build.
		vi.setSystemTime(T0 + 10 * 60_000);
		await t.mutation(internal.mail.imap.serverRegistry.report, {
			...reportArgs(),
			instanceId: 'proc-2',
			startedAt: T0 + 9 * 60_000,
		});

		const rows = await t.run((ctx) => ctx.db.query('imapServers').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			instanceId: 'proc-2',
			startedAt: T0 + 9 * 60_000,
			lastSeenAt: T0 + 10 * 60_000,
		});

		// A new build on the same host is a second row.
		await t.mutation(
			internal.mail.imap.serverRegistry.report,
			reportArgs({ owlatVersion: '0.7.0', wireVersion: 3 })
		);
		expect(await t.run((ctx) => ctx.db.query('imapServers').collect())).toHaveLength(2);
	});

	it('refuses a server older than the minimum and names a backend older than the server', async () => {
		const t = harness();
		const report = (wireVersion: number) =>
			t.mutation(internal.mail.imap.serverRegistry.report, reportArgs({ wireVersion }));

		expect(await report(1)).toEqual({
			backendWireVersion: 3,
			minSupportedWireVersion: 2,
			compatible: false,
			reason: 'server_too_old',
		});
		expect(await report(2)).toMatchObject({ compatible: true });
		expect(await report(4)).toMatchObject({ compatible: false, reason: 'backend_older' });
	});
});

describe('serverRegistry.status', () => {
	it('lists the servers seen in the window with their verdicts', async () => {
		const t = harness();
		await seedServer(t, { hostLabel: 'h1', owlatVersion: '0.6.9', wireVersion: 3, lastSeenAt: T0 });
		await seedServer(t, {
			hostLabel: 'h2',
			owlatVersion: '0.6.8',
			wireVersion: 2,
			lastSeenAt: T0 - DAY,
		});
		await seedServer(t, {
			hostLabel: 'h3',
			owlatVersion: '0.6.8',
			wireVersion: 1,
			lastSeenAt: T0 - 2 * DAY,
		});
		await seedServer(t, {
			hostLabel: 'h4',
			owlatVersion: '0.7.0',
			wireVersion: 4,
			lastSeenAt: T0 - 3 * DAY,
		});
		// Outside the 7-day window.
		await seedServer(t, {
			hostLabel: 'old',
			owlatVersion: '0.6.8',
			wireVersion: 1,
			lastSeenAt: T0 - 10 * DAY,
		});

		const status = await t.query(internal.mail.imap.serverRegistry.status, {});
		expect(status.windowDays).toBe(7);
		expect(status.servers.map((s) => [s.hostLabel, s.verdict])).toEqual([
			['h1', 'current'],
			['h2', 'supported'],
			['h3', 'unsupported'],
			['h4', 'ahead'],
		]);
		expect(status.oldestWireVersionSeen).toBe(1);
		expect(status.safeToRaiseMinTo).toBe(1);
		expect(status.legacyImapSeenAt).toBeNull();
		expect(status.isLegacyInWindow).toBe(false);

		const wider = await t.query(internal.mail.imap.serverRegistry.status, { days: 14 });
		expect(wider.servers.map((s) => s.hostLabel)).toContain('old');
	});

	it('counts a legacy login in the window as wire version 0', async () => {
		const t = harness();
		await seedServer(t, { hostLabel: 'h1', owlatVersion: '0.6.9', wireVersion: 3, lastSeenAt: T0 });
		const appPasswordId = await seedCredential(t);
		vi.setSystemTime(T0 - 2 * DAY);
		await t.mutation(internal.mail.appPasswords.touch, { appPasswordId });
		vi.setSystemTime(T0);

		const status = await t.query(internal.mail.imap.serverRegistry.status, {});
		expect(status.legacyImapSeenAt).toBe(T0 - 2 * DAY);
		expect(status.isLegacyInWindow).toBe(true);
		expect(status.oldestWireVersionSeen).toBe(0);
		expect(status.safeToRaiseMinTo).toBe(0);

		// A day window no longer contains it.
		const narrow = await t.query(internal.mail.imap.serverRegistry.status, { days: 1 });
		expect(narrow.isLegacyInWindow).toBe(false);
		expect(narrow.safeToRaiseMinTo).toBe(3);
	});

	it('allows raising to the current version when nothing reported', async () => {
		const t = harness();
		const status = await t.query(internal.mail.imap.serverRegistry.status, {});
		expect(status.servers).toEqual([]);
		expect(status.oldestWireVersionSeen).toBeNull();
		expect(status.safeToRaiseMinTo).toBe(3);
	});
});

describe('appPasswords.touch legacy detection', () => {
	it('records a login without a wire version as a legacy IMAP server, at most hourly', async () => {
		const t = harness();
		const appPasswordId = await seedCredential(t);

		await t.mutation(internal.mail.appPasswords.touch, { appPasswordId, ip: '203.0.113.9' });
		expect(await legacySeenAt(t)).toBe(T0);

		vi.setSystemTime(T0 + 30 * 60_000);
		await t.mutation(internal.mail.appPasswords.touch, { appPasswordId });
		expect(await legacySeenAt(t)).toBe(T0);

		vi.setSystemTime(T0 + 61 * 60_000);
		await t.mutation(internal.mail.appPasswords.touch, { appPasswordId });
		expect(await legacySeenAt(t)).toBe(T0 + 61 * 60_000);
	});

	it('does not count a reporting IMAP server or an SMTP submission', async () => {
		const t = harness();
		const appPasswordId = await seedCredential(t);

		await t.mutation(internal.mail.appPasswords.touch, { appPasswordId, imapWireVersion: 1 });
		await t.mutation(internal.mail.appPasswords.touch, { appPasswordId, channel: 'smtp' });
		expect(await legacySeenAt(t)).toBeNull();

		// The touch itself still lands.
		const row = await t.run((ctx) => ctx.db.get(appPasswordId));
		expect(row?.lastUsedAt).toBe(T0);
	});
});

describe('serverRegistry.getForAdmin', () => {
	it('is for platform admins only', async () => {
		const t = harness();
		await t.run((ctx) =>
			ctx.db.insert('platformAdmins', {
				authUserId: 'admin-user',
				email: 'admin@example.com',
				role: 'admin',
				createdAt: T0,
			})
		);
		await seedServer(t, { hostLabel: 'h1', owlatVersion: '0.6.9', wireVersion: 3, lastSeenAt: T0 });

		const status = await t.query(api.mail.imap.serverRegistry.getForAdmin, {});
		expect(status.servers.map((s) => s.hostLabel)).toEqual(['h1']);

		caller.subject = 'someone-else';
		await expect(t.query(api.mail.imap.serverRegistry.getForAdmin, {})).rejects.toThrow();
	});
});

describe('serverRegistry.pruneStale', () => {
	it('drops reports not refreshed for 30 days and keeps the rest', async () => {
		const t = harness();
		await seedServer(t, {
			hostLabel: 'gone',
			owlatVersion: '0.6.8',
			wireVersion: 1,
			lastSeenAt: T0 - 31 * DAY,
		});
		await seedServer(t, {
			hostLabel: 'recent',
			owlatVersion: '0.6.9',
			wireVersion: 3,
			lastSeenAt: T0 - 29 * DAY,
		});

		await t.mutation(internal.mail.imap.serverRegistry.pruneStale, {});
		const rows = await t.run((ctx) => ctx.db.query('imapServers').collect());
		expect(rows.map((r) => r.hostLabel)).toEqual(['recent']);
	});
});
