/**
 * A DETAIL PAGE SHOWS A FAILED READ AS AN ERROR, NOT AS "NOT FOUND" (#721).
 *
 * Every dashboard page under a dynamic route segment (`[id]`, `[threadId]`, …)
 * renders one record. When the read for it fails, the query composables leave
 * `data` undefined and set `error`; a page without an error branch falls
 * through to its "not found" state and tells the user the record is gone.
 *
 * A SOURCE lint, so a new detail page cannot ship without the branch: the page
 * must render one itself (a `UiQueryBoundary`, or a `UiErrorAlert` /
 * `ListPageShell` bound to the read's error), or hand the whole record to a
 * component listed in DELEGATES that does. The branches themselves are mounted
 * in `pages/dashboard/__tests__/failedReadPages.test.ts`. List pages are held
 * to it by type instead: `ListPageShell` and `AudienceMemberTable` require an
 * `error` prop.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pagesRoot = join(appRoot, 'pages', 'dashboard');

/** An error branch: the shared boundary, or an alert / list shell shown on a read's error. */
const ERROR_BRANCH =
	/<UiQueryBoundary\b|<ListPageShell\b|<UiErrorAlert\b[^>]*v-(?:else-)?if="[^"]*[eE]rror/;

/**
 * Detail pages whose whole record is read and rendered by one component: the
 * page passes the id through, so the component carries the error branch
 * (`branch` when it is not one of the shared ones).
 */
const DELEGATES: Record<string, { tag: string; file: string; branch?: RegExp }> = {
	'send/emails/[id]/translations.vue': {
		tag: 'TranslationManager',
		file: 'components/translation/Manager.vue',
	},
	'send/transactional/[id]/translations.vue': {
		tag: 'TranslationManager',
		file: 'components/translation/Manager.vue',
	},
	'preferences/members/[mailboxId].vue': {
		tag: 'PostboxTeamInboxMembersPanel',
		file: 'components/postbox/TeamInboxMembersPanel.vue',
	},
	// The mailbox read has its own alert on the page; the list and the open
	// message are the layout's.
	'postbox/[folder]/[[messageId]].vue': {
		tag: 'PostboxLayout',
		file: 'components/postbox/PostboxLayout.vue',
	},
};

function detailPages(): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			if (entry === '__tests__') continue;
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) walk(path);
			else if (entry.endsWith('.vue') && relative(pagesRoot, path).includes('[')) found.push(path);
		}
	};
	walk(pagesRoot);
	return found;
}

describe('detail pages render a failed read as an error (#721)', () => {
	const pages = detailPages();

	it('finds the dynamic-route pages (a broken walk would pass silently)', () => {
		expect(pages.length).toBeGreaterThanOrEqual(20);
	});

	it.each(pages.map((path) => [relative(pagesRoot, path), path]))(
		'%s has an error branch',
		(page, path) => {
			const source = readFileSync(path, 'utf8');
			const delegate = DELEGATES[page];
			if (!delegate) {
				expect(source, `${page}: add an error branch (UiQueryBoundary) for its read`).toMatch(
					ERROR_BRANCH
				);
				return;
			}
			expect(source).toContain(`<${delegate.tag}`);
			const delegateFile = join(appRoot, delegate.file);
			expect(existsSync(delegateFile)).toBe(true);
			expect(readFileSync(delegateFile, 'utf8')).toMatch(delegate.branch ?? ERROR_BRANCH);
		}
	);

	it('lists no delegate for a page that is gone', () => {
		for (const page of Object.keys(DELEGATES)) {
			expect(existsSync(join(pagesRoot, page)), page).toBe(true);
		}
	});
});
