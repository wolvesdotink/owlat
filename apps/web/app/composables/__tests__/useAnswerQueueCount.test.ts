/**
 * The shell's Answer badge (plan 2.11).
 *
 * The sidebar and the phone's tab bar print one number on every dashboard
 * page. They used to get it by subscribing the Answer page's full lists (every
 * inbox's reply-queue cards, the review queue with its joins, the mention
 * previews). This suite pins the cheap path: only count queries are opened,
 * with the list's own limits and gates, and the number is their sum.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { effectScope, ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { api } from '@owlat/api';
import { queryResult } from '~/__tests__/queryStubs';
import { ANSWER_MENTION_LIMIT, ANSWER_REVIEW_LIMIT } from '~/utils/answerQueue';
import { useAnswerQueueCount } from '../useAnswerQueueCount';

const MAIL_COUNT = getFunctionName(api.mail.needsReply.countQueue);
const TEAM_COUNT = getFunctionName(api.inbox.queries.countReviewQueue);
const MENTION_COUNT = getFunctionName(api.chat.mentions.countMyVisibleUnreadMentions);

let isAdmin: ReturnType<typeof ref<boolean>>;
let flags: Set<string>;
let ids: ReturnType<typeof ref<string[]>>;
/** Server answers by function name (mail counts by mailbox id). */
let mailCounts: Record<string, number>;
let teamCount: number;
let mentionCount: number;
/** Every subscription opened: function name + the args it was opened with. */
let opened: Array<{ name: string; args: unknown }>;

beforeEach(() => {
	isAdmin = ref(true);
	flags = new Set(['inbox', 'chat', 'postbox']);
	ids = ref(['mbx_a', 'mbx_b']);
	mailCounts = { mbx_a: 3, mbx_b: 2 };
	teamCount = 4;
	mentionCount = 1;
	opened = [];

	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: (flag: string) => flags.has(flag) }));
	vi.stubGlobal('usePermissions', () => ({ isAdmin }));
	vi.stubGlobal('useInboxes', () => ({ ids }));
	vi.stubGlobal(
		'useConvexQueryMap',
		(fn: FunctionReference<'query'>, keys: typeof ids, argsFor: (key: string) => unknown) => {
			const name = getFunctionName(fn);
			const results = new Map<string, ReturnType<typeof queryResult>>();
			for (const key of keys.value ?? []) {
				opened.push({ name, args: argsFor(key) });
				results.set(key, queryResult(mailCounts[key]));
			}
			return results;
		}
	);
	vi.stubGlobal('useConvexQuery', (fn: FunctionReference<'query'>, args: () => unknown) => {
		const name = getFunctionName(fn);
		const value = args();
		opened.push({ name, args: value });
		if (value === 'skip') return queryResult(undefined);
		return queryResult(name === TEAM_COUNT ? teamCount : mentionCount);
	});
});

function run() {
	const scope = effectScope();
	const result = scope.run(() => useAnswerQueueCount())!;
	return { ...result, stop: () => scope.stop() };
}

describe('useAnswerQueueCount', () => {
	it('opens count queries only, never the lists the Answer page reads', () => {
		run();
		const names = new Set(opened.map((o) => o.name));
		expect(names).toEqual(new Set([MAIL_COUNT, TEAM_COUNT, MENTION_COUNT]));
		expect(names).not.toContain(getFunctionName(api.mail.needsReply.listQueue));
		expect(names).not.toContain(getFunctionName(api.inbox.queries.getReviewQueue));
		expect(names).not.toContain(getFunctionName(api.chat.mentions.listMyUnreadMentions));
	});

	it('asks with the same limits as the list, so the badge counts what the list shows', () => {
		run();
		expect(opened).toContainEqual({ name: MAIL_COUNT, args: { mailboxId: 'mbx_a' } });
		expect(opened).toContainEqual({ name: MAIL_COUNT, args: { mailboxId: 'mbx_b' } });
		expect(opened).toContainEqual({ name: TEAM_COUNT, args: { limit: ANSWER_REVIEW_LIMIT } });
		expect(opened).toContainEqual({ name: MENTION_COUNT, args: { limit: ANSWER_MENTION_LIMIT } });
	});

	it('adds up every inbox, the team drafts and the mentions', () => {
		const { count } = run();
		expect(count.value).toBe(3 + 2 + 4 + 1);
	});

	it('skips the team and mention counts for a member who is not an admin', () => {
		isAdmin.value = false;
		const { count } = run();
		expect(opened).toContainEqual({ name: TEAM_COUNT, args: 'skip' });
		expect(opened).toContainEqual({ name: MENTION_COUNT, args: 'skip' });
		expect(count.value).toBe(3 + 2);
	});

	it('skips a source whose feature is off', () => {
		flags.delete('chat');
		const { count } = run();
		expect(opened).toContainEqual({ name: MENTION_COUNT, args: 'skip' });
		expect(count.value).toBe(3 + 2 + 4);
	});

	it('reads zero while a count has not arrived yet', () => {
		mailCounts = {};
		const { count } = run();
		expect(count.value).toBe(4 + 1);
	});
});
