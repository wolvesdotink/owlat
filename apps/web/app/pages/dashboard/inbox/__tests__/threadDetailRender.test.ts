import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Plan 1.17: the Team Inbox thread page must not re-render on a countdown
 * clock, and its loading state is the page's shape, not a centred spinner.
 *
 * The page is Convex-query driven and awkward to mount in happy-dom, so, like
 * `emptyStates.test.ts` beside it, the load-bearing template facts are asserted
 * against the source. The countdown and the skeleton themselves are mounted in
 * `components/inbox/__tests__/ThreadOutbound.test.ts` and
 * `ThreadDetailSkeleton.test.ts`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(resolve(here, '../[threadId].vue'), 'utf8');
const template = page.slice(page.indexOf('<template>'));

describe('Team Inbox thread page rendering', () => {
	it('hands follow-up countdowns their send time, not a page-computed seconds count', () => {
		expect(template).not.toMatch(/seconds-left=/);
		expect(template).toContain(':send-at="followUp.sendAt"');
		expect(page).not.toMatch(/followUpSecondsLeft/);
	});

	it('runs no sub-second clock of its own', () => {
		const clocks = [...page.matchAll(/useNow\(\{\s*intervalMs:\s*([\d_]+)/g)].map((m) =>
			Number(m[1]!.replace(/_/g, ''))
		);
		for (const interval of clocks) expect(interval).toBeGreaterThanOrEqual(1_000);
	});

	it('loads into the thread-shaped skeleton seeded from the list row', () => {
		expect(template).toContain(
			'<InboxThreadDetailSkeleton v-if="threadLoading && !thread" :preview="threadPreview" />'
		);
		expect(template).not.toContain('<UiSpinner');
		expect(page).toContain('teamThreadPreview(threadId.value)');
	});
});
