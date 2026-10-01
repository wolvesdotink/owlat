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
import { dispatch, hasModule } from '../walker.js';
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
