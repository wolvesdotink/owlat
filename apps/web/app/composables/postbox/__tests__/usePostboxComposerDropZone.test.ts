// @vitest-environment happy-dom
/**
 * The Postbox composer renders inside the shared frame (`PostboxComposerShell`,
 * #812), so its root element is the frame's. `bindRoot` is the function ref
 * that hands that element to the drop zone, the composer keys and the gap
 * clicks: a drop outside it must not attach, and Esc must stay with the
 * composer it was pressed in.
 */
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxComposerShell from '~/components/postbox/PostboxComposerShell.vue';
import { usePostboxComposerDropZone } from '../usePostboxComposerDropZone';

let rootRef: { value: HTMLElement | null } | undefined;
Object.assign(globalThis, {
	useI18n: i18nStubs.useI18n,
	useDropZone: (_onFiles: unknown, options: { rootRef: { value: HTMLElement | null } }) => {
		rootRef = options.rootRef;
		return {
			isDragOver: ref(false),
			handleDragOver: vi.fn(),
			handleDragLeave: vi.fn(),
			handleDrop: vi.fn(),
		};
	},
});

describe('usePostboxComposerDropZone bindRoot', () => {
	it('scopes drops to the shell’s root element, and lets go of it on unmount', () => {
		let zone!: ReturnType<typeof usePostboxComposerDropZone>;
		const Host = defineComponent({
			setup() {
				zone = usePostboxComposerDropZone(async () => {});
				return () =>
					h(
						PostboxComposerShell,
						{ ref: zone.bindRoot, target: { kind: 'mailbox', mailboxId: 'mbx_1' as never } },
						{ default: () => h('p', 'body') }
					);
			},
		});
		const wrapper = mount(Host, { global: { plugins: [createTestI18n()] } });

		const root = wrapper.get('[data-composer-target="mailbox"]').element;
		expect(zone.rootEl.value).toBe(root);
		// The same ref the drop zone reads at drop time.
		expect(rootRef).toBe(zone.rootEl);

		wrapper.unmount();
		expect(zone.rootEl.value).toBeNull();
	});
});
