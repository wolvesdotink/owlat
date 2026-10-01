// @vitest-environment happy-dom
/**
 * The deep body search card's progress strip for existing mail.
 *
 * What is pinned is how a walk that will not finish on its own reads: a failed
 * walk, or one the server reports as stalled (still `running`, but its next
 * batch will never run), shows as stopped with the start button, never as a
 * spinner that runs forever. A live walk keeps its spinner and Cancel.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { useSlots } from 'vue';
import UiCard from '@owlat/ui/components/ui/Card.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import BodySearchIndexCard from '../BodySearchIndexCard.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

type Job = {
	mode: 'index' | 'purge';
	status: 'running' | 'completed' | 'cancelled' | 'failed';
	scannedCount: number;
	indexedCount: number;
	isStalled: boolean;
};

function mountCard(job: Job | null) {
	// The card reads the instance settings first, then the mailbox's job.
	let call = 0;
	vi.stubGlobal('useConvexQuery', () => {
		call += 1;
		const data = call === 1 ? { isBodySearchIndexingEnabled: true } : job;
		return { data: computed(() => data), isLoading: computed(() => false) };
	});
	vi.stubGlobal('usePermissions', () => ({ canManageOrganization: computed(() => true) }));
	vi.stubGlobal('useToast', () => ({ showToast: () => undefined }));
	vi.stubGlobal('usePostboxMailbox', () => ({
		currentMailbox: computed(() => ({ _id: 'mailbox-1' })),
	}));
	vi.stubGlobal('useSlots', useSlots);
	vi.stubGlobal('useBackendOperation', () => ({
		run: async () => ({ ok: true }),
		isLoading: computed(() => false),
	}));

	return mount(BodySearchIndexCard, {
		global: {
			plugins: [createTestI18n()],
			components: { UiCard },
			stubs: {
				Icon: true,
				UiSpinner: true,
				UiIconBox: true,
				UiSwitch: true,
				UiConfirmationDialog: true,
			},
		},
	});
}

const STOPPED = 'Indexing stopped before it finished. Run it again to cover the rest.';

describe('BodySearchIndexCard', () => {
	it('shows a failed walk as stopped, with the start button', () => {
		const wrapper = mountCard({
			mode: 'index',
			status: 'failed',
			scannedCount: 48,
			indexedCount: 40,
			isStalled: false,
		});
		expect(wrapper.text()).toContain(STOPPED);
		expect(wrapper.find('[data-testid="body-search-backfill-start"]').exists()).toBe(true);
	});

	it('shows a stalled walk as stopped rather than as a spinner that never ends', () => {
		const wrapper = mountCard({
			mode: 'index',
			status: 'running',
			scannedCount: 96,
			indexedCount: 90,
			isStalled: true,
		});
		expect(wrapper.text()).toContain(STOPPED);
		expect(wrapper.text()).not.toContain('Indexing… 96 messages read');
		expect(wrapper.find('[data-testid="body-search-backfill-start"]').exists()).toBe(true);
	});

	it('keeps the progress line and Cancel for a live walk', () => {
		const wrapper = mountCard({
			mode: 'index',
			status: 'running',
			scannedCount: 96,
			indexedCount: 90,
			isStalled: false,
		});
		expect(wrapper.text()).toContain('Indexing… 96 messages read');
		expect(wrapper.text()).not.toContain(STOPPED);
		expect(wrapper.find('[data-testid="body-search-backfill-start"]').exists()).toBe(false);
	});

	it('does not call a cancelled walk stopped', () => {
		const wrapper = mountCard({
			mode: 'index',
			status: 'cancelled',
			scannedCount: 48,
			indexedCount: 48,
			isStalled: false,
		});
		expect(wrapper.text()).toContain('Existing mail is not indexed yet.');
		expect(wrapper.text()).not.toContain(STOPPED);
	});
});
