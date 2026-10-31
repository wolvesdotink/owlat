/**
 * APPEND files a message only once its raw bytes are stored: the storage
 * upload's answer must carry a storage id, or the client gets a tagged NO and
 * `appendMessage` is never called.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { appendModule } from '../index.js';
import type { CommandDeps, ConnectionState } from '../../types.js';

// convex/server declares AnyFunctionReference without exporting it.
type AnyFunctionReference = Parameters<typeof getFunctionName>[0];

vi.mock('../../../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../helpers/folders.js', () => ({
	resolveFolderByName: vi.fn(async () => ({ _id: 'f1', path: 'INBOX', role: 'inbox' })),
}));

const BODY = Buffer.from('Subject: hi\r\n\r\nhello\r\n');

const STATE: ConnectionState = {
	auth: { mailboxId: 'mb1', appPasswordId: 'ap1', address: 'alice@example.com', userId: 'u1' },
	selected: null,
	clientId: null,
};

async function append(uploadAnswer: Response) {
	vi.spyOn(globalThis, 'fetch').mockResolvedValue(uploadAnswer);
	const calls: string[] = [];
	const mutation = vi.fn(async (ref: AnyFunctionReference) => {
		const name = getFunctionName(ref);
		calls.push(name);
		if (name === 'mail/imap/append:generateRawUploadUrl') return 'https://upload.example.com/blob';
		return { uid: 7, uidValidity: 100, modseq: 1 };
	});
	const deps = { convex: { mutation }, remoteIp: '192.0.2.1' } as unknown as CommandDeps;
	const parsed = appendModule.parseArgs(['INBOX', `{${BODY.length}+}`]);
	if (!parsed.ok) throw new Error(parsed.error);
	const lines: string[] = [];
	const session = appendModule.start({
		deps,
		state: STATE,
		args: parsed.args,
		tag: 'p1',
		verb: 'APPEND',
		send: (line) => lines.push(String(line)),
	});
	session.onLiteralBytes?.(BODY);
	await session.completion;
	return { lines, calls };
}

const json = (value: unknown) =>
	new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
	vi.restoreAllMocks();
});

describe('APPEND storage upload answer', () => {
	it('files the message under the storage id the upload answered with', async () => {
		const { lines, calls } = await append(json({ storageId: 'sid1' }));
		expect(lines.at(-1)).toBe('p1 OK [APPENDUID 100 7] APPEND completed');
		expect(calls).toContain('mail/imap/append:appendMessage');
	});

	it.each([
		['null', json(null)],
		['a list', json([{ storageId: 'sid1' }])],
		['no storage id', json({})],
		['a numeric storage id', json({ storageId: 42 })],
		['an empty storage id', json({ storageId: '' })],
		['a body that is not JSON', new Response('<html>gateway</html>')],
	])('answers NO and files nothing for an answer with %s', async (_name, answer) => {
		const { lines, calls } = await append(answer);
		expect(lines.at(-1)).toBe('p1 NO APPEND storage upload failed');
		expect(calls).not.toContain('mail/imap/append:appendMessage');
	});
});
