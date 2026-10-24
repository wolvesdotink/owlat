/**
 * `useTabBadge` against a real head manager: the base favicon is declared the
 * way `nuxt.config.ts` declares it, a page owns its title the way dashboard
 * pages do, and the assertions read the rendered `document.title` and icon
 * links. Rendering is driven by hand (the head is created with a no-op
 * renderer and `renderDOMHead` runs after Vue flushes), so nothing waits on a
 * timer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref, type Ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { useHead } from '@unhead/vue';
import { createHead, renderDOMHead } from '@unhead/vue/client';
import { FAVICON_HEAD_KEY, UNREAD_FAVICON_HREF } from '~/lib/tabBadge';

type Head = ReturnType<typeof createHead>;

let head: Head;
let wrapper: VueWrapper | null = null;

function iconHrefs(): (string | null)[] {
	return [...document.head.querySelectorAll('link[rel="icon"]')].map((l) => l.getAttribute('href'));
}

async function render(): Promise<void> {
	await nextTick();
	await renderDOMHead(head, { document });
}

/**
 * Mount the dashboard shape: an owner that badges the tab, with a page inside
 * it that sets its own (reactive) title. `showPage` toggles the page alone.
 */
async function mountShell(options: {
	count: Ref<number | null>;
	pageTitle: Ref<string | undefined>;
	showPage?: Ref<boolean>;
}): Promise<VueWrapper> {
	const { useTabBadge } = await import('../useTabBadge');
	const showPage = options.showPage ?? ref(true);
	const Page = defineComponent({
		setup() {
			useHead({ title: () => options.pageTitle.value });
			return () => h('main');
		},
	});
	const Owner = defineComponent({
		setup() {
			useTabBadge(options.count);
			return () => h('div', showPage.value ? [h(Page)] : []);
		},
	});
	wrapper = mount(Owner, { global: { plugins: [head] } });
	await render();
	return wrapper;
}

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('useHead', useHead);
	document.head.innerHTML = '';
	document.title = '';
	head = createHead({ render: () => {} });
	// What Nuxt pushes from `app.head` before any component mounts.
	head.push({
		link: [{ key: FAVICON_HEAD_KEY, rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
	});
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

describe('useTabBadge', () => {
	it('prefixes the title once and swaps in the dotted favicon for a positive count', async () => {
		await mountShell({ count: ref(3), pageTitle: ref('Mail — Owlat') });

		expect(document.title).toBe('(3) Mail — Owlat');
		expect(iconHrefs()).toEqual([UNREAD_FAVICON_HREF]);

		// Re-rendering never stacks a second prefix or a second icon.
		await render();
		await render();
		expect(document.title).toBe('(3) Mail — Owlat');
		expect(iconHrefs()).toEqual([UNREAD_FAVICON_HREF]);
	});

	it('restores the plain title and favicon when the count drops to zero', async () => {
		const count = ref<number | null>(3);
		await mountShell({ count, pageTitle: ref('Mail — Owlat') });

		count.value = 0;
		await render();

		expect(document.title).toBe('Mail — Owlat');
		expect(iconHrefs()).toEqual(['/favicon.svg']);

		count.value = 5;
		await render();
		expect(document.title).toBe('(5) Mail — Owlat');
		expect(iconHrefs()).toEqual([UNREAD_FAVICON_HREF]);
	});

	it('paints nothing while the count is unknown', async () => {
		await mountShell({ count: ref(null), pageTitle: ref('Mail — Owlat') });

		expect(document.title).toBe('Mail — Owlat');
		expect(iconHrefs()).toEqual(['/favicon.svg']);
	});

	it('keeps the prefix while the page title changes underneath it', async () => {
		const pageTitle = ref<string | undefined>('Mail — Owlat');
		await mountShell({ count: ref(4), pageTitle });

		// A route change to another page, then a locale switch.
		pageTitle.value = 'Contacts — Owlat';
		await render();
		expect(document.title).toBe('(4) Contacts — Owlat');

		pageTitle.value = 'Kontakte — Owlat';
		await render();
		expect(document.title).toBe('(4) Kontakte — Owlat');
	});

	it('badges the product name on a page without a title', async () => {
		const showPage = ref(false);
		await mountShell({ count: ref(2), pageTitle: ref('Mail — Owlat'), showPage });

		expect(document.title).toBe('(2) Owlat');

		showPage.value = true;
		await render();
		expect(document.title).toBe('(2) Mail — Owlat');
	});

	it('removes both overrides when its owner unmounts', async () => {
		const count = ref<number | null>(7);
		const shell = await mountShell({ count, pageTitle: ref('Mail — Owlat') });
		expect(document.title).toBe('(7) Mail — Owlat');

		shell.unmount();
		wrapper = null;
		// The app's own page title survives the dashboard leaving.
		head.push({ title: 'Sign in — Owlat' });
		await render();

		expect(document.title).toBe('Sign in — Owlat');
		expect(iconHrefs()).toEqual(['/favicon.svg']);
	});
});
