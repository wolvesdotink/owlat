// @vitest-environment happy-dom
/**
 * "Draft with AI" on a team thread needs the `ai` flag and the team inbox,
 * nothing else: a team-only instance (no Postbox, no external mail) has it.
 */
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useAnswerTeamAssist } from '../useAnswerTeamAssist';

vi.mock('~/composables/useAnswerCatchUp', () => ({
	useAnswerCatchUp: () => ({ statusNote: ref(undefined) }),
}));
vi.mock('~/composables/useAnswerAskSession', () => ({ useAnswerAskSession: () => ({}) }));

function draftWithAiUnder(flags: string[]) {
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: (f: string) => flags.includes(f) }));
	let result!: ReturnType<typeof useAnswerTeamAssist>;
	mount(
		defineComponent({
			setup() {
				result = useAnswerTeamAssist({
					threadId: () => 'ct_1' as never,
					composer: () => null,
					messageCount: () => 3,
					view: ref('summary'),
					attachFile: () => {},
				});
				return () => h('div');
			},
		})
	);
	return result.draftWithAi.value;
}

describe('useAnswerTeamAssist: Draft with AI', () => {
	it('is on for a team-only instance', () => {
		expect(draftWithAiUnder(['ai', 'inbox'])).toBe(true);
	});

	it('is off without the team inbox, whatever else is on', () => {
		expect(draftWithAiUnder(['ai', 'postbox', 'mail.external'])).toBe(false);
	});

	it('is off with AI off', () => {
		expect(draftWithAiUnder(['inbox', 'postbox'])).toBe(false);
	});
});
