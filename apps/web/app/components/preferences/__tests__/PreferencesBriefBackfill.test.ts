// @vitest-environment happy-dom
/**
 * "Prepare overviews for recent mail" (ADR-0072, D5): Prepare starts the
 * personal mailbox's backfill, a running walk offers Stop, and a paused or
 * stopped one says why and offers Resume.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import PreferencesBriefBackfill from '../PreferencesBriefBackfill.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const status = ref<unknown>(null);
const startRun = vi.fn(async () => ({ ok: true }));
const cancelRun = vi.fn(async () => ({ ok: true }));
const inboxes = ref<unknown[]>([]);

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useInboxes', () => ({ inboxes }));
	vi.stubGlobal('useConvexQuery', () => ({ data: status, isLoading: ref(false) }));
	vi.stubGlobal('useBackendOperation', (_fn: unknown, opts: { label: () => string }) =>
		opts.label() === 'Prepare overviews'
			? { run: startRun, isLoading: ref(false) }
			: { run: cancelRun, isLoading: ref(false) }
	);
});

beforeEach(() => {
	status.value = null;
	inboxes.value = [
		{ mailboxId: 'team1', scope: 'shared' },
		{ mailboxId: 'mine', scope: 'personal' },
	];
	startRun.mockClear();
	cancelRun.mockClear();
});

const Button = {
	props: ['variant', 'size', 'loading'],
	emits: ['click'],
	template: '<button @click="$emit(\'click\')"><slot /></button>',
};

function mountRow() {
	return mount(PreferencesBriefBackfill, {
		global: { plugins: [createTestI18n()], stubs: { UiButton: Button } },
	});
}

describe('PreferencesBriefBackfill', () => {
	it('starts the personal mailbox’s walk', async () => {
		const w = mountRow();
		expect(w.get('button').text()).toBe('Prepare');
		await w.get('button').trigger('click');
		await flushPromises();
		expect(startRun).toHaveBeenCalledWith({ mailboxId: 'mine' });
		expectFullyLocalized(w);
	});

	it('offers Stop while it runs and shows how far it got', async () => {
		status.value = { status: 'running', threadCount: 3 };
		const w = mountRow();
		expect(w.get('[data-testid="brief-backfill-note"]').text()).toBe(
			'Preparing… 3 conversations so far'
		);
		await w.get('button').trigger('click');
		expect(cancelRun).toHaveBeenCalledWith({ mailboxId: 'mine' });
	});

	it('says why it paused and resumes', () => {
		status.value = { status: 'paused', pausedReason: 'budget', threadCount: 5 };
		const w = mountRow();
		expect(w.get('[data-testid="brief-backfill-note"]').text()).toBe(
			'Paused: the AI budget is used up for now.'
		);
		expect(w.get('button').text()).toBe('Resume');
	});

	it('is absent without a personal mailbox', () => {
		inboxes.value = [{ mailboxId: 'team1', scope: 'shared' }];
		expect(mountRow().find('[data-testid="brief-backfill"]').exists()).toBe(false);
	});
});
