/**
 * The People view asks for topic names once per state of a topic: a name the
 * person reset, or a conversation that grew, is asked about again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import type { PeopleTopic } from '~/utils/postboxPeople';
import { usePostboxTopicTitleRequests } from '../usePostboxPeople';

const run = vi.fn(async () => ({ ok: true }));
beforeEach(() => {
	run.mockClear();
	vi.stubGlobal('useBackendOperation', () => ({ run }));
});

const topic = (overrides: Partial<PeopleTopic>) =>
	({ id: 't1', titleSource: 'subject', messageCount: 2, ...overrides }) as PeopleTopic;

describe('topic title requests', () => {
	it('asks again after a reset and after the conversation grew, not on a plain re-render', async () => {
		const visible = ref<PeopleTopic[]>([topic({})]);
		effectScope().run(() => usePostboxTopicTitleRequests(ref('mb' as never), visible));
		expect(run).toHaveBeenCalledTimes(1);

		visible.value = [topic({})];
		await nextTick();
		expect(run).toHaveBeenCalledTimes(1);

		// Owlat named it: nothing to ask.
		visible.value = [topic({ titleSource: 'ai' })];
		await nextTick();
		expect(run).toHaveBeenCalledTimes(1);
		// The person reset the name to the subject: ask again.
		visible.value = [topic({})];
		await nextTick();
		expect(run).toHaveBeenCalledTimes(2);
		// The conversation grew: ask again.
		visible.value = [topic({ messageCount: 3 })];
		await nextTick();
		expect(run).toHaveBeenCalledTimes(3);
	});
});
