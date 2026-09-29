/**
 * Ratchet: every Postbox page that resolves the current mailbox renders
 * `PostboxMailboxGuard`.
 *
 * The guard owns the no-mailbox next step (reserved, connect an external
 * account, ask an admin). Pages that hand-rolled their own empty state told a
 * member waiting on a reserved mailbox to add an account, or showed a bare
 * sentence with nothing while loading. A new page that reads
 * `usePostboxMailbox()` without the guard fails here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const postboxPagesRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function vueFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return name === '__tests__' ? [] : vueFiles(path);
		return name.endsWith('.vue') ? [path] : [];
	});
}

const pages = vueFiles(postboxPagesRoot)
	.map((path) => ({ page: relative(postboxPagesRoot, path), source: readFileSync(path, 'utf8') }))
	.filter(({ source }) => source.includes('usePostboxMailbox()'));

describe('Postbox pages render the mailbox guard', () => {
	it('finds the pages that resolve a mailbox', () => {
		// A broken walk would pass every assertion below vacuously.
		expect(pages.map(({ page }) => page)).toEqual(
			expect.arrayContaining([
				'files.vue',
				'subscriptions.vue',
				'search.vue',
				'contacts.vue',
				join('[folder]', 'index.vue'),
				join('[folder]', '[messageId].vue'),
				join('label', '[labelId].vue'),
			])
		);
	});

	it.each(pages.map(({ page, source }) => [page, source]))(
		'%s wraps its content in <PostboxMailboxGuard>',
		(_page, source) => {
			expect(source).toContain('<PostboxMailboxGuard');
			// The guard decides the no-mailbox state itself; forcing it with a
			// literal null is the bypass this ratchet exists to stop.
			expect(source).not.toMatch(/<PostboxMailboxGuard[^>]*:mailbox-id="null"/);
		}
	);
});
