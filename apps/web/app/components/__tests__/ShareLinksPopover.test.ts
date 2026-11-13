/**
 * Revoking a share link cuts off everyone it already went to, so it asks
 * first; and a create whose clipboard write the browser refused does not
 * claim the link was copied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import ShareLinksPopover from '../ShareLinksPopover.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const revoke = vi.fn();
const create = vi.fn();
const confirm = vi.fn();
const copy = vi.fn();
const showToast = vi.fn();

const LINK = {
	_id: 'link_1',
	_creationTime: Date.now(),
	token: 'tok_1',
	expiresAt: Date.now() + 3_600_000,
};

let wrapper: VueWrapper | undefined;

beforeEach(() => {
	revoke.mockReset().mockResolvedValue({ ok: true, result: null });
	create.mockReset().mockResolvedValue({
		ok: true,
		result: { url: 'https://owlat.example/share?token=new' },
	});
	confirm.mockReset();
	copy.mockReset().mockResolvedValue(true);
	showToast.mockReset();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePermissions', () => ({ can: () => true }));
	vi.stubGlobal('useConvexQuery', () => ({ data: ref([LINK]) }));
	vi.stubGlobal('useBackendOperation', (_op: unknown, options: { label: () => string }) => ({
		run: options.label() === 'Revoke share link' ? revoke : create,
	}));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useConfirm', () => confirm);
	vi.stubGlobal('useCopyToClipboard', () => ({ copy, copiedKey: ref(null) }));
	vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://owlat.example' } }));
	vi.stubGlobal('useClickOutside', () => {});
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = undefined;
});

async function openPanel() {
	wrapper = mount(ShareLinksPopover, {
		props: { emailTemplateId: 'tpl_1' as never, hasUnsavedChanges: false },
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiTooltip: { template: '<div><slot /></div>' },
				UiButton: { template: '<button type="button"><slot name="iconLeft" /><slot /></button>' },
			},
		},
	});
	await wrapper.get('button').trigger('click');
	await nextTick();
	await nextTick();
}

const bodyButton = (label: string) =>
	document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe('ShareLinksPopover', () => {
	it('keeps the link when the revoke is not confirmed', async () => {
		confirm.mockResolvedValue(false);
		await openPanel();

		bodyButton('Revoke link')!.click();
		await flushPromises();

		expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ variant: 'danger' }));
		expect(revoke).not.toHaveBeenCalled();
	});

	it('revokes once confirmed', async () => {
		confirm.mockResolvedValue(true);
		await openPanel();

		bodyButton('Revoke link')!.click();
		await flushPromises();

		expect(revoke).toHaveBeenCalledWith({ shareLinkId: 'link_1' });
	});

	it('does not say "copied" when the clipboard refused, and offers the URL', async () => {
		copy.mockResolvedValue(false);
		await openPanel();

		const createButton = [...document.body.querySelectorAll('button')].find((b) =>
			b.textContent?.includes('Create share link')
		)!;
		createButton.click();
		await flushPromises();

		expect(showToast).toHaveBeenCalledWith('Share link created. Copy it from the list.', 'success');
		const fallback = document.body.querySelector<HTMLInputElement>('input[readonly]');
		expect(fallback?.value).toBe('https://owlat.example/share?token=new');
	});
});
