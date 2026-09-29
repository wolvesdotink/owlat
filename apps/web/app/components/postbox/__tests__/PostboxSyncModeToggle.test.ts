// @vitest-environment happy-dom
/**
 * The two-way sync switch on a connected mailbox. Pinned: flipping it saves
 * the mode through the right mutation — the member's own for their mailbox, the
 * team inbox's (with its id) on a team inbox — says what changed only once it
 * saved, and never saves a no-op.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, computed } from 'vue';

import PostboxSyncModeToggle from '../PostboxSyncModeToggle.vue';
import { createTestI18n, i18nStubs, expectFullyLocalized } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => {
	const pathProxy = (path: string): unknown =>
		new Proxy(function () {}, {
			get: (_target, key) =>
				key === '__path' ? path : pathProxy(path === '' ? String(key) : `${path}.${String(key)}`),
		});
	return { api: pathProxy('') };
});

const personalRun = vi.fn(async (_args: unknown) => ({ ok: true }));
const sharedRun = vi.fn(async (_args: unknown) => ({ ok: true }));
const toasts: string[] = [];

beforeAll(() => {
	vi.stubGlobal('useBackendOperation', (reference: { __path: string }) => ({
		run: reference.__path.endsWith('setSharedSyncMode') ? sharedRun : personalRun,
		isLoading: ref(false),
	}));
	vi.stubGlobal('useToast', () => ({ showToast: (message: string) => void toasts.push(message) }));
	vi.stubGlobal('useId', () => 'sync-switch');
	vi.stubGlobal('computed', computed);
	vi.stubGlobal('ref', ref);
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

beforeEach(() => {
	personalRun.mockClear();
	sharedRun.mockClear();
	personalRun.mockImplementation(async () => ({ ok: true }));
	toasts.length = 0;
});

const switchStub = {
	props: ['modelValue', 'disabled', 'id'],
	emits: ['update:modelValue'],
	template:
		'<button class="switch" :aria-checked="String(modelValue)" @click="$emit(\'update:modelValue\', !modelValue)" />',
};

const mountToggle = (props: Record<string, unknown>) =>
	mount(PostboxSyncModeToggle, {
		props,
		global: { plugins: [createTestI18n()], stubs: { UiSwitch: switchStub } },
	});

describe('PostboxSyncModeToggle', () => {
	it('shows two-way sync as on, and explains it', () => {
		const wrapper = mountToggle({ mode: 'full' });
		expect(wrapper.find('.switch').attributes('aria-checked')).toBe('true');
		expect(wrapper.text()).toContain('works both ways');
		expectFullyLocalized(wrapper);
	});

	it('turns the caller’s own mailbox to new mail only', async () => {
		const wrapper = mountToggle({ mode: 'full' });
		await wrapper.find('.switch').trigger('click');
		await flushPromises();
		expect(personalRun).toHaveBeenCalledWith({ mode: 'incoming' });
		expect(sharedRun).not.toHaveBeenCalled();
		expect(toasts).toEqual(['Only new mail comes in from now on.']);
	});

	it('sets a team inbox through its own mutation, with its id', async () => {
		const wrapper = mountToggle({ mode: 'incoming', mailboxId: 'mailbox_support' });
		await wrapper.find('.switch').trigger('click');
		await flushPromises();
		expect(sharedRun).toHaveBeenCalledWith({ mailboxId: 'mailbox_support', mode: 'full' });
	});

	it('claims nothing when the save is refused', async () => {
		personalRun.mockImplementation(async () => ({ ok: false }));
		const wrapper = mountToggle({ mode: 'full' });
		await wrapper.find('.switch').trigger('click');
		await flushPromises();
		expect(toasts).toEqual([]);
	});
});
