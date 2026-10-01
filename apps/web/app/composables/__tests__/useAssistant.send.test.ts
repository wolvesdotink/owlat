/**
 * `useAssistant.send` reports whether the question was accepted (#1049), so
 * the composer can keep it until then, and a retry after a failed first
 * message reuses the conversation that send created instead of making a
 * second, empty one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';

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

type Outcome = { ok: true; result: unknown } | { ok: false };
const runs: Record<string, ReturnType<typeof vi.fn>> = {};

beforeEach(() => {
	for (const name of ['createConversation', 'sendMessage']) {
		runs[name] = vi.fn(async (): Promise<Outcome> => ({ ok: true, result: null }));
	}
	// Nuxt auto-imports, installed as globals the way the setup file installs
	// `ref` and friends (so not `vi.stubGlobal`, whose unstub would drop those).
	Object.assign(globalThis, {
		useI18n: () => ({ t: (key: string) => key }),
		useConvexQuery: () => ({
			data: ref([]),
			isLoading: ref(false),
			error: ref(null),
			refetch: () => {},
		}),
		useBackendOperation: (fn: string) => ({
			run: runs[fn] ?? vi.fn(async () => ({ ok: true, result: null })),
		}),
	});
});

afterEach(() => {
	vi.resetModules();
});

async function setup() {
	const { useAssistant } = await import('../useAssistant');
	const scope = effectScope();
	const assistant = scope.run(() => useAssistant())!;
	return { assistant, scope };
}

describe('useAssistant.send outcome (#1049)', () => {
	it('resolves ok once the message is accepted', async () => {
		runs.createConversation!.mockResolvedValueOnce({ ok: true, result: 'conv_1' });
		const { assistant, scope } = await setup();

		await expect(assistant.send('Hello')).resolves.toEqual({ ok: true });
		expect(runs.sendMessage).toHaveBeenCalledWith({ conversationId: 'conv_1', text: 'Hello' });
		scope.stop();
	});

	it('resolves not ok when creating the conversation fails, and sends nothing', async () => {
		runs.createConversation!.mockResolvedValueOnce({ ok: false });
		const { assistant, scope } = await setup();

		await expect(assistant.send('Hello')).resolves.toEqual({ ok: false });
		expect(runs.sendMessage).not.toHaveBeenCalled();
		expect(assistant.activeId.value).toBeNull();
		scope.stop();
	});

	it('retries a failed first message into the conversation it already created', async () => {
		runs.createConversation!.mockResolvedValueOnce({ ok: true, result: 'conv_1' });
		runs.sendMessage!.mockResolvedValueOnce({ ok: false });
		const { assistant, scope } = await setup();

		await expect(assistant.send('Hello')).resolves.toEqual({ ok: false });
		expect(assistant.activeId.value).toBe('conv_1');

		await expect(assistant.send('Hello')).resolves.toEqual({ ok: true });
		expect(runs.createConversation).toHaveBeenCalledTimes(1);
		expect(runs.sendMessage).toHaveBeenCalledTimes(2);
		expect(runs.sendMessage!.mock.calls[1]).toEqual([{ conversationId: 'conv_1', text: 'Hello' }]);
		scope.stop();
	});

	it('sends into the open conversation without creating one', async () => {
		const { assistant, scope } = await setup();
		assistant.selectConversation('conv_open' as never);

		await expect(assistant.send('Hi')).resolves.toEqual({ ok: true });
		expect(runs.createConversation).not.toHaveBeenCalled();
		expect(runs.sendMessage).toHaveBeenCalledWith({ conversationId: 'conv_open', text: 'Hi' });
		scope.stop();
	});
});
