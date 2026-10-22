import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * The Team inbox thread's keys are catalog ids in the `inbox` scope, bound
 * through the app-wide dispatcher, so a remap on the shortcuts page moves them
 * and the "?" sheet lists them. What a press DOES under that scope (the new
 * key fires once, the old one stops, `n` comes back to "new item" outside) is
 * driven by real key events in `useKeyboardShortcutsChords.test.ts`; like the
 * other suites beside it, this one asserts the page's wiring against its
 * source, because the Convex-driven page is awkward to mount in happy-dom.
 */
const here = dirname(fileURLToPath(import.meta.url));
const thread = readFileSync(resolve(here, '../[threadId].vue'), 'utf8');
const list = readFileSync(resolve(here, '../index.vue'), 'utf8');

describe('Team inbox keys', () => {
	it('claims the inbox scope on the thread page and binds its three ids', () => {
		expect(thread).toContain("useShortcutScope('inbox')");
		for (const id of ['inbox.assignToMe', 'inbox.reply', 'inbox.note']) {
			expect(thread).toContain(`id: '${id}'`);
		}
		expect(thread).not.toMatch(/addEventListener\(\s*['"]keydown/);
	});

	it('keeps the note key for admins, as the composer note is theirs', () => {
		expect(thread).toMatch(/id: 'inbox\.note',[\s\S]*?when: \(\) => isAdmin\.value/);
	});

	it('resolves the list row assign key through the same id', () => {
		expect(list).toContain("resolveActiveChord(key, ['inbox']) === 'inbox.assignToMe'");
	});
});
