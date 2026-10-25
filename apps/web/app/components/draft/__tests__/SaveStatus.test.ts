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
import RecoveryNotice from '../RecoveryNotice.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useNow } from '~/composables/useNow';
import { SaveRefusedError } from '~/composables/useEditorSaveOperation';
import type { DraftAutosave } from '~/composables/useDraftAutosave';
import type { DraftSaveStatus } from '~/utils/draftSessionSelectors';
import { createDraftSession } from '~/utils/draftSession';
import { formatDateTime } from '~/utils/formatters';

const i18n = createTestI18n();
const buttonStub = {
	emits: ['click'],
	template: '<button @click="$emit(\'click\')"><slot /></button>',
};
const t = i18n.global.t;

/** What the status reads of a session, set by the test. */
function autosaveIn(
	status: DraftSaveStatus,
	over: { savedAt?: number; error?: unknown; onDevice?: boolean; conflict?: boolean } = {}
) {
	const state = shallowRef({
		...createDraftSession({ writer: 'tab-a.1' }),
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
		onDevice: computed(() => over.onDevice ?? false),
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
				Icon: true,
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

	it.each<[DraftSaveStatus, string, string | null]>([
		['saving', 'shared.draftAutosave.saving', null],
		['editing', 'shared.draftAutosave.editing', null],
		['unkept', 'shared.draftAutosave.unkept', 'shared.draftAutosave.unkeptDetail'],
		['scheduling', 'shared.draftAutosave.scheduling', 'shared.draftAutosave.schedulingDetail'],
	])('says %s, with its reason where there is one', (status, label, detail) => {
		const wrapper = mountStatus(autosaveIn(status).autosave);
		const live = wrapper.get('[role="status"]').text();
		expect(live).toContain(t(label));
		if (detail) expect(live).toContain(t(detail));
		expect(wrapper.find('button').exists()).toBe(false);
		wrapper.unmount();
	});

	it('tells offline with a copy on this device from offline with none', () => {
		const kept = mountStatus(autosaveIn('offline', { onDevice: true }).autosave);
		expect(kept.text()).toContain(t('shared.draftAutosave.offlineOnDevice'));
		const lost = mountStatus(autosaveIn('offline').autosave);
		expect(lost.text()).toContain(t('shared.draftAutosave.offlineNotSaved'));
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

describe('RecoveryNotice', () => {
	const mountNotice = (confirm: boolean, savedAt = Date.now() - 60_000) =>
		mount(RecoveryNotice, {
			props: { savedAt, confirm },
			global: {
				plugins: [i18n],
				stubs: {
					Icon: true,
					UiButton: buttonStub,
				},
			},
		});

	it('offers the copy: Restore or Discard, never applied by itself', async () => {
		const wrapper = mountNotice(false);
		expect(wrapper.text()).toContain(t('shared.draftAutosave.recovery.restore'));
		const [discard, restore] = wrapper.findAll('button');
		await restore!.trigger('click');
		await discard!.trigger('click');
		expect(wrapper.emitted('restore')).toHaveLength(1);
		expect(wrapper.emitted('discard')).toHaveLength(1);
	});

	it('asks once more when the draft was edited since', () => {
		const savedAt = Date.now() - 60_000;
		const wrapper = mountNotice(true, savedAt);
		expect(wrapper.text()).toContain(t('shared.draftAutosave.recovery.restoreAnyway'));
		expect(wrapper.text()).toContain(
			t('shared.draftAutosave.recovery.confirm', { when: formatDateTime(savedAt) })
		);
	});
});
