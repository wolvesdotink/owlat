import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * There is one answer queue. The old "Team drafts to review" page is a
 * redirect into it, filtered to the team inbox, and the Team inbox's
 * "Review drafts" button goes straight there (source guards: both pages are
 * Convex-driven and awkward to mount).
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');

describe('one answer queue', () => {
	it('redirects /dashboard/inbox/review to the Answer queue filtered to the team inbox', () => {
		const source = read('../review.vue');
		expect(source).toContain("redirect: { path: '/dashboard/answer', query: { in: 'team' } }");
		expect(source).not.toContain('ReviewBrowseList');
	});

	it('points the Team inbox "Review drafts" button at the same place', () => {
		const source = read('../index.vue');
		expect(source).toContain(":to=\"{ path: '/dashboard/answer', query: { in: 'team' } }\"");
		expect(source).not.toContain('to="/dashboard/inbox/review"');
	});
});
