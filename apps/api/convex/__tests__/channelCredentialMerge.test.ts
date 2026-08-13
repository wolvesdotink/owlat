import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { decryptChannelCreds } from '../channels/credentials';
import { createTestChannelConfig } from './factories';
import type { Doc, Id } from '../_generated/dataModel';

/**
 * Partial channel-credential saves must MERGE, never replace.
 *
 * The settings form can never prefill a stored credential (the envelope is
 * AES-256-GCM and only openable in a Node action), so every save is partial by
 * construction. Replacing the whole envelope therefore meant that adding the
 * WhatsApp App Secret dropped the Access Token outbound sends with, and
 * retyping the Access Token dropped the App Secret inbound signature
 * verification needs — a configured channel silently 503ing on inbound.
 *
 * These cover the merge itself, the non-secret presence map
 * (`configuredFields`) the form uses to mark a credential as already stored,
 * and the diagnostics on the read side — a stored envelope that will not open
 * (rotated INSTANCE_SECRET) or a credential the operator never filled in are
 * the two ways inbound 503s with a channel that looks configured, so both say
 * so in the log without ever naming a value.
 */

const modules = import.meta.glob('../**/*.*s');

/** Owner session for the authedQuery floor on `getChannelConfigs`. */
let sessionRole: 'owner' | 'member' = 'owner';
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<Record<string, unknown>>('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: 'test-user',
			role: sessionRole,
			activeOrganizationId: 'org-1',
		})),
	};
});

beforeEach(() => {
	sessionRole = 'owner';
	process.env['INSTANCE_SECRET'] = 'test-instance-secret';
});

type Harness = ReturnType<typeof convexTest>;

/** Save credentials through the real encrypt-on-write action. */
async function saveConfig(
	t: Harness,
	channel: 'sms' | 'whatsapp' | 'generic',
	config: Record<string, string>
) {
	await t.action(internal.channels.outbound.encryptAndPersistConfig, {
		channel,
		plaintextConfig: JSON.stringify(config),
	});
}

/** Read the row back and open its envelope the way the dispatch path does. */
async function storedCreds(t: Harness, channel: 'sms' | 'whatsapp' | 'generic') {
	const row = (await t.run(async (ctx) => {
		const rows = await ctx.db.query('channelConfigs').collect();
		return rows.find((r) => r.channel === channel) ?? null;
	})) as Doc<'channelConfigs'> | null;
	return {
		row,
		creds: row?.config ? decryptChannelCreds(row.config, channel) : null,
	};
}

describe('channels.outbound.encryptAndPersistConfig', () => {
	it('keeps the credentials a later partial save does not mention', async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			ctx.db.insert('channelConfigs', createTestChannelConfig({ channel: 'whatsapp' }))
		);

		await saveConfig(t, 'whatsapp', {
			accessToken: 'meta-access-token',
			phoneNumberId: '123456',
			appSecret: 'meta-app-secret',
			verifyToken: 'meta-verify-token',
		});
		// The operator comes back and rotates ONLY the access token.
		await saveConfig(t, 'whatsapp', { accessToken: 'rotated-access-token' });

		const { creds } = await storedCreds(t, 'whatsapp');
		expect(creds).toEqual({
			accessToken: 'rotated-access-token',
			phoneNumberId: '123456',
			appSecret: 'meta-app-secret',
			verifyToken: 'meta-verify-token',
		});
	});

	it('adds an inbound-only credential without dropping the outbound ones', async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			ctx.db.insert('channelConfigs', createTestChannelConfig({ channel: 'whatsapp' }))
		);

		await saveConfig(t, 'whatsapp', { accessToken: 'meta-access-token', phoneNumberId: '123456' });
		await saveConfig(t, 'whatsapp', { appSecret: 'meta-app-secret' });

		const { creds } = await storedCreds(t, 'whatsapp');
		expect(creds?.accessToken).toBe('meta-access-token');
		expect(creds?.phoneNumberId).toBe('123456');
		expect(creds?.appSecret).toBe('meta-app-secret');
	});

	it('treats a blank field as "unchanged", never as "clear this credential"', async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			ctx.db.insert('channelConfigs', createTestChannelConfig({ channel: 'sms' }))
		);

		await saveConfig(t, 'sms', {
			accountSid: 'AC123',
			authToken: 'twilio-auth-token',
			phoneNumber: '+15550000000',
		});
		await saveConfig(t, 'sms', { accountSid: 'AC456', authToken: '', phoneNumber: '' });

		const { creds } = await storedCreds(t, 'sms');
		expect(creds).toEqual({
			accountSid: 'AC456',
			authToken: 'twilio-auth-token',
			phoneNumber: '+15550000000',
		});
	});

	it('stores exactly what the first save supplies when nothing is stored yet', async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			ctx.db.insert('channelConfigs', createTestChannelConfig({ channel: 'generic' }))
		);

		await saveConfig(t, 'generic', {
			endpointUrl: 'https://example.com/hook',
			secretKey: 'shared-secret',
		});

		const { creds } = await storedCreds(t, 'generic');
		expect(creds).toEqual({
			endpointUrl: 'https://example.com/hook',
			secretKey: 'shared-secret',
		});
	});

	it('re-establishes a channel whose stored envelope can no longer be opened', async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			ctx.db.insert(
				'channelConfigs',
				createTestChannelConfig({ channel: 'sms', config: 'not-an-envelope' })
			)
		);

		await saveConfig(t, 'sms', { accountSid: 'AC123', authToken: 'twilio-auth-token' });

		const { creds } = await storedCreds(t, 'sms');
		expect(creds).toEqual({ accountSid: 'AC123', authToken: 'twilio-auth-token' });
	});

	it('never merges a payload that is not a JSON object', async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			ctx.db.insert('channelConfigs', createTestChannelConfig({ channel: 'sms' }))
		);

		await saveConfig(t, 'sms', { accountSid: 'AC123', authToken: 'twilio-auth-token' });
		await t.action(internal.channels.outbound.encryptAndPersistConfig, {
			channel: 'sms',
			plaintextConfig: 'not-json',
		});

		const { creds } = await storedCreds(t, 'sms');
		expect(creds).toEqual({ accountSid: 'AC123', authToken: 'twilio-auth-token' });
	});

	it('records the merged field NAMES so the form can mark them stored', async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			ctx.db.insert('channelConfigs', createTestChannelConfig({ channel: 'whatsapp' }))
		);

		await saveConfig(t, 'whatsapp', { accessToken: 'meta-access-token' });
		await saveConfig(t, 'whatsapp', { appSecret: 'meta-app-secret', verifyToken: '' });

		const { row } = await storedCreds(t, 'whatsapp');
		expect([...(row!.configuredFields ?? [])].sort()).toEqual(['accessToken', 'appSecret']);
		// Names only — a value must never ride along in the presence map.
		expect(row!.configuredFields).not.toContain('meta-access-token');
	});
});

describe('channels.credentials.getInboundSecret', () => {
	it('says so in the log when the stored envelope will not open', async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			ctx.db.insert(
				'channelConfigs',
				createTestChannelConfig({ channel: 'whatsapp', config: 'not-an-envelope' })
			)
		);
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

		const secret = await t.action(internal.channels.credentials.getInboundSecret, {
			channel: 'whatsapp',
			field: 'signature',
		});

		expect(secret).toBeNull();
		const messages = logged.mock.calls.map((call) => String(call[0]));
		expect(messages.some((m) => m.includes('whatsapp') && /could not be opened/.test(m))).toBe(
			true
		);
		logged.mockRestore();
	});

	it('names the missing field — never a value — when the credential was never filled in', async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			ctx.db.insert('channelConfigs', createTestChannelConfig({ channel: 'whatsapp' }))
		);
		// Outbound credentials only: the inbound App Secret is left unset.
		await saveConfig(t, 'whatsapp', { accessToken: 'meta-access-token', phoneNumberId: '123456' });
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

		const secret = await t.action(internal.channels.credentials.getInboundSecret, {
			channel: 'whatsapp',
			field: 'signature',
		});

		expect(secret).toBeNull();
		const messages = logged.mock.calls.map((call) => String(call[0]));
		expect(messages.some((m) => m.includes("no 'appSecret'"))).toBe(true);
		expect(messages.every((m) => !m.includes('meta-access-token'))).toBe(true);
		logged.mockRestore();
	});

	it('hands over the stored secret when it is there', async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			ctx.db.insert('channelConfigs', createTestChannelConfig({ channel: 'whatsapp' }))
		);
		await saveConfig(t, 'whatsapp', { appSecret: 'meta-app-secret' });

		await expect(
			t.action(internal.channels.credentials.getInboundSecret, {
				channel: 'whatsapp',
				field: 'signature',
			})
		).resolves.toBe('meta-app-secret');
	});
});

describe('unifiedMessages.getChannelConfigs', () => {
	it('gives an admin the presence map but never the encrypted envelope', async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			ctx.db.insert('channelConfigs', createTestChannelConfig({ channel: 'sms' }))
		);
		await saveConfig(t, 'sms', { accountSid: 'AC123', authToken: 'twilio-auth-token' });

		const rows = await t.query(api.unifiedMessages.getChannelConfigs, {});
		expect(rows).toHaveLength(1);
		expect(rows[0]!.config).toBeUndefined();
		expect([...(rows[0]!.configuredFields ?? [])].sort()).toEqual(['accountSid', 'authToken']);
	});

	it('withholds the presence map from a non-admin member', async () => {
		const t = convexTest(schema, modules);
		let configId!: Id<'channelConfigs'>;
		await t.run(async (ctx) => {
			configId = await ctx.db.insert('channelConfigs', createTestChannelConfig({ channel: 'sms' }));
		});
		await saveConfig(t, 'sms', { accountSid: 'AC123', authToken: 'twilio-auth-token' });

		sessionRole = 'member';
		const rows = await t.query(api.unifiedMessages.getChannelConfigs, {});
		expect(rows[0]!._id).toBe(configId);
		expect(rows[0]!.config).toBeUndefined();
		expect(rows[0]!.configuredFields).toBeUndefined();
		// The non-secret health/display fields still reach every member.
		expect(rows[0]!.channel).toBe('sms');
	});
});
