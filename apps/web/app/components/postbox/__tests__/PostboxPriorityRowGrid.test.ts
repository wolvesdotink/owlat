/**
 * The Priority view's groups share one row grid (read on arrival §3): the
 * "Needs you" queue rows (PostboxPriorityQueueList) put the avatar, the sender
 * column and the line column at the same x as the thread rows of "Everything
 * else" and "Updates" (PostboxThreadRow + PostboxThreadRowBody). Layout is not
 * measurable here, so this pins the spacing both sides are built from.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxPriorityQueueList from '../PostboxPriorityQueueList.vue';
import type { ReplyQueueItem } from '~/utils/postboxReplyQueue';

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

const here = dirname(fileURLToPath(import.meta.url));
const source = (name: string) => readFileSync(join(here, '..', name), 'utf8');

/** Tailwind spacing units of the first class matching `pattern` in `classes`. */
function units(classes: string, pattern: RegExp): number {
	const match = classes.match(pattern);
	expect(match, `${pattern} in "${classes}"`).not.toBeNull();
	return Number(match![1]);
}

/** The static class list on the element whose classes contain `marker`. */
function classesWith(sfc: string, marker: string): string {
	const found = [...sfc.matchAll(/class="([^"]*)"/g)].find((m) => m[1]!.includes(marker));
	expect(found, marker).toBeDefined();
	return found![1]!;
}

const item: ReplyQueueItem = {
	threadId: 't1',
	messageId: 'm1',
	urgency: 'high',
	detectedAt: 1,
	source: 'heuristic',
	fromAddress: 'lena@studio.example',
	fromName: 'Lena Hoffmann',
	subject: 'Send the signed quote',
	snippet: '',
	receivedAt: 1,
};

describe('Priority view row grid', () => {
	it('puts the queue rows on the thread rows’ avatar, sender and line columns', () => {
		const w = mount(PostboxPriorityQueueList, {
			props: { items: [item], href: '/dashboard/answer' },
			global: {
				plugins: [createTestI18n()],
				stubs: {
					UiAvatar: { template: '<span class="avatar" />' },
					NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				},
			},
		});
		const queueLink = w.get('a').classes().join(' ');
		const queueColumns = w.get('a > span.flex-1').classes().join(' ');
		const queueSender = w.get('a > span.flex-1 > span').classes().join(' ');

		const row = source('PostboxThreadRow.vue');
		const threadLink = classesWith(row, 'pbx-row-link');
		const checkbox = classesWith(row, 'pbx-row-checkbox');
		const threadFlex = classesWith(row, 'flex items-start gap-');
		const body = source('PostboxThreadRowBody.vue');
		const threadColumns = classesWith(body, 'max-sm:flex-col sm:items-baseline');
		const threadSender = classesWith(body, 'sm:w-');

		// Avatar x: the thread row's padding, checkbox and gap; the queue row's left padding.
		const threadAvatarX =
			units(threadLink, /\bpx-(\d+)\b/) +
			units(checkbox, /\bw-(\d+)\b/) +
			units(threadFlex, /\bgap-(\d+)\b/);
		expect(units(queueLink, /\bpl-(\d+)\b/)).toBe(threadAvatarX);
		// Sender x: the same avatar (size sm on both) and the same gap after it.
		expect(units(queueLink, /\bgap-(\d+)\b/)).toBe(units(threadFlex, /\bgap-(\d+)\b/));
		expect(row).toMatch(/<UiAvatar[^>]*size="sm"/);
		expect(source('PostboxPriorityQueueList.vue')).toMatch(/<UiAvatar[^>]*size="sm"/);
		// Line x: the same sender column width and the same gap after it.
		expect(units(queueSender, /\bsm:w-(\d+)\b/)).toBe(units(threadSender, /\bsm:w-(\d+)\b/));
		expect(units(queueColumns, /\bgap-x-(\d+)\b/)).toBe(units(threadColumns, /\bgap-x-(\d+)\b/));
	});
});
