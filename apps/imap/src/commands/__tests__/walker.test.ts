/**
 * Registry coverage: every `ImapVerb` has a command module.
 *
 * The walker builds its registry at runtime from the `MODULES` list, so a
 * verb whose module entry was dropped or renamed still compiles, and the
 * server then answers that verb `BAD Command "X" not supported`. Modules
 * that contribute no CAPABILITY atom (STATUS, CHECK, COPY, EXPUNGE, ...)
 * would slip past capabilities.test.ts. `ImapVerb` is derived from
 * `IMAP_VERBS`, so a new verb cannot reach the type without reaching the
 * list this test walks.
 */

import { describe, expect, it, vi } from 'vitest';
import { dispatch, hasModule, runsConcurrently } from '../walker.js';
import { IMAP_VERBS, type CommandDeps, type ConnectionState } from '../types.js';

vi.mock('../../logger.js', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('IMAP command walker — registry coverage', () => {
	it.each(IMAP_VERBS)('%s has a registered module', (verb) => {
		expect(hasModule(verb)).toBe(true);
	});

	it('lists each verb once', () => {
		expect(new Set(IMAP_VERBS).size).toBe(IMAP_VERBS.length);
	});

	it('answers BAD for a verb without a module, which is what a missing entry would ship', () => {
		const sent: string[] = [];
		const state: ConnectionState = { auth: null, selected: null, clientId: null };
		dispatch({} as CommandDeps, state, { tag: 'a1', command: 'XFOO', args: [] }, (line) =>
			sent.push(String(line))
		);
		expect(sent).toEqual(['a1 BAD Command "XFOO" not supported']);
	});
});

describe('IMAP command walker — which commands may overlap (RFC 3501 §5.5)', () => {
	it.each([
		'a FETCH 1:* (UID FLAGS)',
		'a FETCH 1 BODY.PEEK[]',
		'a FETCH 1 RFC822.HEADER',
		'a UID FETCH 1:* (FLAGS)',
		'a NOOP',
		'a CHECK',
		'a IDLE',
		'a LIST "" "*"',
		'a STATUS INBOX (MESSAGES)',
		'a CAPABILITY',
	])('%s runs beside earlier commands', (line) => {
		expect(runsConcurrently(line)).toBe(true);
	});

	it.each([
		// A body FETCH without .PEEK sets \Seen, so it writes flags.
		'a FETCH 1 BODY[]',
		'a FETCH 1 (UID RFC822)',
		'a UID FETCH 1 BODY[TEXT]',
		'a UID STORE 1 +FLAGS (\\Seen)',
		'a STORE 1 +FLAGS (\\Deleted)',
		'a EXPUNGE',
		'a COPY 1 Archive',
		'a MOVE 1 Archive',
		'a SELECT INBOX',
		'a EXAMINE INBOX',
		'a CLOSE',
		'a LOGIN user pass',
		'a LOGOUT',
		'a ENABLE CONDSTORE',
		'a ID NIL',
		// A literal, an unknown verb and an unparseable FETCH wait too.
		'a LOGIN {4}',
		'a XFOO',
		'a FETCH',
	])('%s runs alone', (line) => {
		expect(runsConcurrently(line)).toBe(false);
	});
});
