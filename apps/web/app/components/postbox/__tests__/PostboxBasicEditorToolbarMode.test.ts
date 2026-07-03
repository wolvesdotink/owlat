// @vitest-environment happy-dom
/**
 * PostboxBasicEditor toolbar-mode behavior:
 *   - default (persistentToolbar = false, the Apple-minimal mode): the classic
 *     top toolbar is hidden and the floating format bar is mounted instead
 *   - persistentToolbar = true: the classic top toolbar is shown and the floating
 *     bar is not mounted
 *
 * The floating bar's on-selection positioning is exercised in
 * PostboxFloatingFormatBar.test.ts; here we only assert the editor picks the
 * right surface for the preference.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { onBeforeMount, onBeforeUnmount } from 'vue';
import { mount } from '@vue/test-utils';

// Stub the two Nuxt lifecycle auto-imports the editor uses that the shared setup
// file does not polyfill.
beforeAll(() => {
	vi.stubGlobal('onBeforeMount', onBeforeMount);
	vi.stubGlobal('onBeforeUnmount', onBeforeUnmount);
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('requireConvex', () => ({ action: vi.fn() }));
});

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

// Import AFTER the mocks so the component's `@owlat/api` import is intercepted.
const { default: PostboxBasicEditor } = await import('../PostboxBasicEditor.vue');

const persistentStub = { template: '<div data-testid="persistent-toolbar" />' };
const floatingStub = { template: '<div data-testid="floating-bar" />' };

function mountEditor(props: Record<string, unknown> = {}) {
	return mount(PostboxBasicEditor, {
		props: { modelValue: '<p>hi</p>', ...props },
		global: {
			stubs: {
				PostboxEditorToolbar: persistentStub,
				PostboxFloatingFormatBar: floatingStub,
				PostboxRewriteLayer: true,
				Icon: { props: ['name'], template: '<span />' },
			},
		},
	});
}

describe('PostboxBasicEditor toolbar mode', () => {
	it('shows the floating bar and hides the persistent toolbar by default', () => {
		const wrapper = mountEditor();
		expect(wrapper.find('[data-testid="floating-bar"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="persistent-toolbar"]').exists()).toBe(false);
	});

	it('shows the persistent toolbar and hides the floating bar when opted in', () => {
		const wrapper = mountEditor({ persistentToolbar: true });
		expect(wrapper.find('[data-testid="persistent-toolbar"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="floating-bar"]').exists()).toBe(false);
	});
});
