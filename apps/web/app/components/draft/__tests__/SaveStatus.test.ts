/**
 * The save state beside a draft's title (`SaveStatus.vue`): it renders what
 * the session derives and decides nothing itself. Only the state is a live
 * region; the age beside "Saved" changes as time passes without anything
 * being announced. Fake, pinned clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, shallowRef } from 'vue';
import SaveStatus from '../SaveStatus.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useNow } from '~/composables/useNow';
import { SaveRefusedError } from '~/composables/useEditorSaveOperation';
import type { DraftAutosave } from '~/composables/useDraftAutosave';
import type { DraftSaveStatus } from '~/utils/draftSessionSelectors';
import { createDraftSession } from '~/utils/draftSession';

const i18n = createTestI18n();
const buttonStub = {
	emits: ['click'],
	template: '<button @click="$emit(\'click\')"><slot /></button>',
};
const t = i18n.global.t;

/** What the status reads of a session, set by the test. */
function autosaveIn(
	status: DraftSaveStatus,
	over: { savedAt?: number; error?: unknown; conflict?: boolean } = {}
) {
	const state = shallowRef({
		...createDraftSession(),
		conflict: over.conflict ? { revision: 4, mustReload: false, open: true } : null,
	});
	const status$ = shallowRef(status);
	const savedAt = shallowRef(over.savedAt ?? null);
	const retry = vi.fn();
	const autosave = {
		state,
		status: computed(() => status$.value),
		savedAt: computed(() => savedAt.value),
		error: computed(() => over.error ?? null),
		retry,
	} as unknown as DraftAutosave;
	return { autosave, retry, status$ };
}

function mountStatus(autosave: DraftAutosave) {
	return mount(SaveStatus, {
		props: { autosave },
		global: {
			plugins: [i18n],
			stubs: {
				UiButton: buttonStub,
			},
		},
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-10-25T09:00:00Z'));
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useNow', useNow);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('SaveStatus', () => {
	it('keeps the age outside the live region, so time passing announces nothing', async () => {
		const { autosave } = autosaveIn('saved', { savedAt: Date.now() });
		const wrapper = mountStatus(autosave);
		const live = () => wrapper.get('[role="status"]').text();
		expect(live()).toBe(t('shared.draftAutosave.saved'));
		const before = wrapper.text();

		await vi.advanceTimersByTimeAsync(11_000);
		expect(live()).toBe(t('shared.draftAutosave.saved'));
		expect(wrapper.text()).not.toBe(before);
		wrapper.unmount();
	});

	it.each<[DraftSaveStatus, string]>([
		['saving', 'shared.draftAutosave.saving'],
		['editing', 'shared.draftAutosave.editing'],
		['unsaved', 'shared.draftAutosave.unsaved'],
		['offline', 'shared.draftAutosave.offlineNotSaved'],
	])('says %s, never Saved, and offers no Retry', (status, label) => {
		const wrapper = mountStatus(autosaveIn(status, { savedAt: Date.now() }).autosave);
		const live = wrapper.get('[role="status"]').text();
		expect(live).toBe(t(label));
		expect(wrapper.text()).not.toContain(t('shared.draftAutosave.saved'));
		expect(wrapper.find('button').exists()).toBe(false);
		wrapper.unmount();
	});

	it('shows a refused save with its reason and Retry, but no Retry over a conflict', async () => {
		const error = new SaveRefusedError({
			category: 'invalid_input',
			message: 'Name is too long',
		} as never);
		const { autosave, retry } = autosaveIn('error', { error });
		const wrapper = mountStatus(autosave);
		expect(wrapper.get('[role="status"]').text()).toContain(t('shared.draftAutosave.notSaved'));
		await wrapper.get('button').trigger('click');
		expect(retry).toHaveBeenCalledOnce();

		const conflict = mountStatus(autosaveIn('error', { error, conflict: true }).autosave);
		expect(conflict.find('button').exists()).toBe(false);
	});
});
