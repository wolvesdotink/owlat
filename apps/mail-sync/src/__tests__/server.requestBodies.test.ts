/**
 * The worker's JSON routes decode their bodies before doing any work.
 *
 * A cast checks nothing: a recipient list holding a number would reach the
 * SMTP envelope, and a `/test` body whose credentials are the wrong shape
 * would reach a live IMAP login. Every refusal here is a 400 answered before
 * Convex, the network or a mail server is asked anything.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailSyncConfig } from '../config.js';
import type { ConvexClient } from '../convex.js';

const { fetchCreds, testConnection, sendViaExternal } = vi.hoisted(() => ({
	fetchCreds: vi.fn(),
	testConnection: vi.fn(),
	sendViaExternal: vi.fn(),
}));

vi.mock('../convex.js', () => ({ fetchWorkerCredentials: fetchCreds }));
vi.mock('../send.js', () => ({
	testConnection,
	sendViaExternal,
	fileSentCopyInBackground: vi.fn(),
}));
vi.mock('../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createApp } from '../server.js';

const API_KEY = 'test-api-key';
const config = {
	apiKey: API_KEY,
	allowedFetchOrigins: ['http://convex:3210'],
} as unknown as MailSyncConfig;

const requestRemoteOps = vi.fn(() => true);

function post(path: string, body: string) {
	return createApp(config, {} as ConvexClient, { requestRemoteOps }).request(path, {
		method: 'POST',
		headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
		body,
	});
}

const creds = {
	host: 'imap.example.com',
	port: 993,
	secure: true,
	username: 'me@example.com',
	password: 'secret',
};

beforeEach(() => {
	vi.clearAllMocks();
	testConnection.mockResolvedValue({ imap: { ok: true }, smtp: { ok: true } });
});

describe('POST /send', () => {
	it.each([
		['a recipient that is a number', { recipients: ['x@example.com', 7] }],
		['recipients that are not a list', { recipients: 'x@example.com' }],
		['a numeric account id', { externalAccountId: 1 }],
	])('refuses %s before fetching credentials', async (_name, override) => {
		const res = await post(
			'/send',
			JSON.stringify({
				externalAccountId: 'acc-1',
				from: 'me@example.com',
				recipients: ['x@example.com'],
				rawEmlUrl: 'http://convex:3210/api/storage/abc',
				...override,
			})
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: 'externalAccountId, from, recipients, rawEmlUrl required',
		});
		expect(fetchCreds).not.toHaveBeenCalled();
		expect(sendViaExternal).not.toHaveBeenCalled();
	});
});

describe('POST /test', () => {
	it.each([
		['a port sent as a string', { imap: { ...creds, port: '993' }, smtp: creds }],
		['missing smtp credentials', { imap: creds }],
		['credentials that are null', { imap: null, smtp: creds }],
	])('refuses %s before any login', async (_name, body) => {
		const res = await post('/test', JSON.stringify(body));
		expect(res.status).toBe(400);
		expect(testConnection).not.toHaveBeenCalled();
	});

	it('refuses malformed JSON with a 400', async () => {
		const res = await post('/test', '{"imap":');
		expect(res.status).toBe(400);
		expect(testConnection).not.toHaveBeenCalled();
	});

	it('tests well-formed credentials, ignoring a field it does not know', async () => {
		const res = await post(
			'/test',
			JSON.stringify({ imap: creds, smtp: { ...creds, addedNextRelease: true } })
		);
		expect(res.status).toBe(200);
		expect(testConnection).toHaveBeenCalledOnce();
	});
});

describe('POST /remote-ops', () => {
	it('refuses a numeric account id', async () => {
		const res = await post('/remote-ops', JSON.stringify({ accountId: 5 }));
		expect(res.status).toBe(400);
		expect(requestRemoteOps).not.toHaveBeenCalled();
	});

	it('nudges the account named by a string id', async () => {
		const res = await post('/remote-ops', JSON.stringify({ accountId: 'acc-1' }));
		expect(res.status).toBe(202);
		expect(requestRemoteOps).toHaveBeenCalledWith('acc-1');
	});
});
