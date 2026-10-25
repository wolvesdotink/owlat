/**
 * `useAssistant.promptHistory`: the open conversation's questions for the
 * composer's ↑, and nothing while that conversation's messages are loading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';

vi.mock('@owlat/api', () => ({
	api: {
		assistant: {
			conversations: {
				listConversations: 'listConversations',
				listMessages: 'listMessages',
				createConversation: 'createConversation',
				sendMessage: 'sendMessage',
				stopGeneration: 'stopGeneration',
				renameConversation: 'renameConversation',
				deleteConversation: 'deleteConversation',
			},
		},
	},
}));

const messages = ref<{ _id: string; role: string; text: string }[]>([]);
const messagesLoading = ref(false);

beforeEach(() => {
	messages.value = [];
	messagesLoading.value = false;
	// Nuxt auto-imports, installed as globals the way the setup file installs
	// `ref` and friends (so not `vi.stubGlobal`, whose unstub would drop those).
	Object.assign(globalThis, {
		useI18n: () => ({ t: (key: string) => key }),
		useConvexQuery: (query: string) =>
			query === 'listMessages'
				? { data: messages, isLoading: messagesLoading, error: ref(null), refetch: () => {} }
				: {
						data: ref([{ _id: 'conv_1', title: 'Launch recap' }]),
						isLoading: ref(false),
						error: ref(null),
						refetch: () => {},
					},
		useBackendOperation: () => ({ run: vi.fn(async () => ({ ok: true, result: null })) }),
	});
});

afterEach(() => {
	vi.resetModules();
});

describe('useAssistant.promptHistory', () => {
	it('lists the open conversation’s questions, oldest first', async () => {
		const { useAssistant } = await import('../useAssistant');
		const scope = effectScope();
		const assistant = scope.run(() => useAssistant())!;
		await nextTick();
		expect(assistant.activeId.value).toBe('conv_1');

		messages.value = [
			{ _id: 'u1', role: 'user', text: 'How did the launch go?' },
			{ _id: 'a1', role: 'assistant', text: 'Well.' },
			{ _id: 'u2', role: 'user', text: 'Which segment opened most?' },
		];
		expect(assistant.promptHistory.value).toEqual([
			{ id: 'u1', prompt: 'How did the launch go?' },
			{ id: 'u2', prompt: 'Which segment opened most?' },
		]);

		// Switching conversations: nothing to recall until its messages arrive.
		messagesLoading.value = true;
		expect(assistant.promptHistory.value).toEqual([]);
		scope.stop();
	});
});
