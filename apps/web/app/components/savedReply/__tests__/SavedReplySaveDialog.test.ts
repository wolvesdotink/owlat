// @vitest-environment happy-dom
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import SavedReplySaveDialog from '../SavedReplySaveDialog.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

/**
 * "Save as reply" from a composer whose body holds a pasted image (#1293). The
 * image's bytes are a part of the draft, so a saved reply cannot keep it: the
 * dialog says the image is left out, and what it saves has no trace of it
 * rather than an empty `<img>` that later drafts would send.
 */
const run = vi.fn(async (_args: Record<string, unknown>) => ({ ok: true, result: 'sn_new' }));

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		usePermissions: () => ({ isAdmin: ref(false) }),
		useBackendOperation: () => ({ run, isLoading: ref(false) }),
	});
});
enableAutoUnmount(afterEach);
afterEach(() => run.mockClear());

const PASTED =
	'<p>Our new logo:</p><p><img data-inline-cid="logo@owlat" alt="logo.png" style="max-width: 100%; height: auto;"></p><p>Best, Ada</p>';

function mountDialog(bodyHtml: string) {
	return mount(SavedReplySaveDialog, {
		props: { bodyHtml, open: true },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				UiModal: { template: '<div><slot /></div>' },
				UiButton: {
					props: ['disabled'],
					template: '<button :disabled="disabled"><slot /></button>',
				},
			},
		},
	});
}

async function save(wrapper: ReturnType<typeof mountDialog>) {
	await wrapper.get('input[type="text"]').setValue('New logo');
	await wrapper.get('form').trigger('submit');
	await nextTick();
}

describe('SavedReplySaveDialog', () => {
	it('saves the text without a pasted image, and says it is left out', async () => {
		const wrapper = mountDialog(PASTED);
		expect(wrapper.get('[data-testid="saved-reply-images-left-out"]').text()).toBe(
			'A saved reply cannot keep pasted images, so this one is left out. Paste it again after you insert the reply.'
		);

		await save(wrapper);
		expect(run).toHaveBeenCalledTimes(1);
		const saved = run.mock.calls[0]![0];
		expect(saved['bodyHtml']).toBe('<p>Our new logo:</p><p></p><p>Best, Ada</p>');
		expect(saved['bodyHtml']).not.toContain('<img');
	});

	it('counts several', () => {
		const wrapper = mountDialog(`${PASTED}<p><img data-inline-cid="chart@owlat"></p>`);
		expect(wrapper.get('[data-testid="saved-reply-images-left-out"]').text()).toContain(
			'so these 2 images are left out'
		);
	});

	it('says nothing and keeps the body as written when there is no pasted image', async () => {
		const body = '<p>Hi,</p><p><img src="https://cdn.owlat.example/banner.png" alt="banner"></p>';
		const wrapper = mountDialog(body);
		expect(wrapper.find('[data-testid="saved-reply-images-left-out"]').exists()).toBe(false);

		await save(wrapper);
		expect(run.mock.calls[0]![0]['bodyHtml']).toBe(body);
	});
});
