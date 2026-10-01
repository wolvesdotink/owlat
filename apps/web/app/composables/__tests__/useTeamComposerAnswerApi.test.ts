import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useTeamComposerAnswerApi } from '../useTeamComposerAnswerApi';

/** "Draft with AI" writes into the team reply, and Discard gives the old text back. */
describe('useTeamComposerAnswerApi', () => {
	it('streams, settles and discards an AI draft over what was written', async () => {
		const body = ref('My own start');
		const touch = vi.fn();
		const api = useTeamComposerAnswerApi({ body, touch, focus: vi.fn() });
		expect(api.draftText.value).toBe('My own start');

		api.streamAiDraft('Hi Ana,');
		expect(body.value).toBe('Hi Ana,');
		await api.applyAiDraft('Hi Ana, here it is.');
		expect(body.value).toBe('Hi Ana, here it is.');
		expect(api.aiDraft.value).toBe('Hi Ana, here it is.');
		expect(touch).toHaveBeenCalled();

		api.discardAiDraft();
		expect(body.value).toBe('My own start');
		expect(api.aiDraft.value).toBeNull();
	});

	it('has no draft row: the ask session targets the thread', async () => {
		const api = useTeamComposerAnswerApi({ body: ref(''), touch: vi.fn(), focus: vi.fn() });
		expect(await api.ensureDraftId()).toBeNull();
	});
});
