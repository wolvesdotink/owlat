// @vitest-environment happy-dom
/**
 * The workspace logo (#810): uploaded in Workspace → General, shown in place
 * of the Owlat mark on the pages people reach without an account.
 *
 * Pinned here:
 *  - dark mode never loses the logo: a dark variant swaps in, and without one
 *    the light logo sits on a light plate
 *  - the sign-in shell shows the workspace logo instead of the Owlat mark, and
 *    keeps the Owlat mark when no logo is set
 *  - the settings card refuses a wrong format or an oversized file before
 *    uploading anything, binds an upload to the slot it was picked for, and
 *    keeps the dark slot closed until there is a main logo
 *  - the sign-in page and its shell share one sender lookup
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { getFunctionName } from 'convex/server';
import { useSlots } from 'vue';
import { MAX_WORKSPACE_LOGO_BYTES } from '@owlat/shared/workspaceLogo';
import UiCard from '@owlat/ui/components/ui/Card.vue';
import UiButton from '@owlat/ui/components/ui/Button.vue';
import WorkspaceLogo from '../WorkspaceLogo.vue';
import AuthShell from '~/components/auth/AuthShell.vue';
import WorkspaceLogoCard from '~/components/settings/WorkspaceLogoCard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useRecipientSender } from '~/composables/useRecipientSender';

const LOGO = 'https://files.owlat.test/logo.svg';
const LOGO_DARK = 'https://files.owlat.test/logo-dark.svg';

describe('WorkspaceLogo', () => {
	it('swaps in the dark variant in dark mode when there is one', () => {
		const w = mount(WorkspaceLogo, { props: { url: LOGO, darkUrl: LOGO_DARK } });
		const light = w.get('[data-testid="workspace-logo-light"]');
		const dark = w.get('[data-testid="workspace-logo-dark"]');
		expect(light.attributes('src')).toBe(LOGO);
		expect(light.classes()).toContain('dark:hidden');
		expect(dark.attributes('src')).toBe(LOGO_DARK);
		expect(dark.classes()).toEqual(expect.arrayContaining(['hidden', 'dark:block']));
		expect(w.find('[data-testid="workspace-logo-plated"]').exists()).toBe(false);
	});

	it('puts the light logo on a light plate in dark mode when there is no dark variant', () => {
		const w = mount(WorkspaceLogo, { props: { url: LOGO } });
		const img = w.get('[data-testid="workspace-logo-plated"]');
		expect(img.attributes('src')).toBe(LOGO);
		expect(img.classes()).toContain('dark:bg-white');
		expect(w.findAll('img')).toHaveLength(1);
	});

	it('is decorative: the page heading names the workspace', () => {
		const w = mount(WorkspaceLogo, { props: { url: LOGO } });
		expect(w.get('img').attributes('alt')).toBe('');
	});
});

describe('sign-in shell', () => {
	let sender: Record<string, unknown>;
	const query = vi.fn(async () => sender);

	beforeEach(() => {
		query.mockClear();
		vi.stubGlobal('useConvex', () => ({ query }));
		vi.stubGlobal('useRecipientSender', useRecipientSender);
	});

	function mountShell() {
		return mount(AuthShell, {
			slots: { title: 'Northwind Studio' },
			global: { components: { WorkspaceLogo }, stubs: { UiHeroField: true } },
		});
	}

	it('shows the workspace logo instead of the Owlat mark', async () => {
		sender = { name: 'Northwind Studio', contactEmail: null, logoUrl: LOGO, logoDarkUrl: null };
		const w = mountShell();
		await flushPromises();
		expect(w.find('[data-testid="workspace-logo"]').exists()).toBe(true);
		expect(w.find('img[src="/owlat.svg"]').exists()).toBe(false);
	});

	it('keeps the Owlat mark when no logo is set', async () => {
		sender = { name: 'Northwind Studio', contactEmail: null, logoUrl: null, logoDarkUrl: null };
		const w = mountShell();
		await flushPromises();
		expect(w.find('[data-testid="workspace-logo"]').exists()).toBe(false);
		expect(w.find('img[src="/owlat.svg"]').exists()).toBe(true);
	});

	it('shares one lookup between a page and its shell', async () => {
		sender = { name: null, contactEmail: null, logoUrl: null, logoDarkUrl: null };
		const Page = {
			components: { AuthShell },
			setup: () => useRecipientSender(),
			template: '<AuthShell><template #title>x</template></AuthShell>',
		};
		mount(Page, { global: { components: { WorkspaceLogo }, stubs: { UiHeroField: true } } });
		await flushPromises();
		expect(query).toHaveBeenCalledTimes(1);
	});
});

describe('WorkspaceLogoCard', () => {
	type Call = { fn: string; args: Record<string, unknown> };

	function mountCard(logo: { logoUrl: string | null; logoDarkUrl: string | null }) {
		const calls: Call[] = [];
		const toasts: Array<{ message: string; type?: string }> = [];
		vi.stubGlobal('useI18n', i18nStubs.useI18n);
		vi.stubGlobal('useSlots', useSlots);
		vi.stubGlobal('useConvexQuery', () => ({
			data: computed(() => logo),
			isLoading: computed(() => false),
		}));
		vi.stubGlobal('usePermissions', () => ({ canManageSettings: computed(() => true) }));
		vi.stubGlobal('useToast', () => ({
			showToast: (message: string, type?: string) => toasts.push({ message, type }),
		}));
		vi.stubGlobal('useBackendOperation', (ref: unknown) => ({
			run: async (args: Record<string, unknown>) => {
				const fn = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
				calls.push({ fn, args });
				return fn === 'storage:generateUploadUrl'
					? { ok: true, result: 'https://app.owlat.test/api/storage/upload?token=t' }
					: { ok: true, result: null };
			},
			isLoading: computed(() => false),
		}));
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ storageId: 'kg_logo' })))
		);
		const wrapper = mount(WorkspaceLogoCard, {
			global: {
				plugins: [createTestI18n()],
				components: { UiCard, UiButton },
				stubs: { Icon: true, UiSpinner: true, UiIconBox: true },
			},
		});
		return { wrapper, calls, toasts };
	}

	async function choose(wrapper: ReturnType<typeof mount>, variant: string, file: File) {
		const input = wrapper.get(`[data-testid="workspace-logo-slot-${variant}"] input[type="file"]`);
		Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
		await input.trigger('change');
		await flushPromises();
	}

	it('uploads a picked file and binds it to the slot it was picked for', async () => {
		const { wrapper, calls, toasts } = mountCard({ logoUrl: LOGO, logoDarkUrl: null });
		await choose(wrapper, 'dark', new File(['<svg></svg>'], 'dark.svg', { type: 'image/svg+xml' }));
		expect(calls.map((c) => c.fn)).toEqual([
			'storage:generateUploadUrl',
			'workspaces/branding:setLogo',
		]);
		expect(calls[1]!.args).toEqual({
			storageId: 'kg_logo',
			variant: 'dark',
		});
		expect(toasts).toEqual([{ message: 'Logo updated', type: undefined }]);
	});

	it('refuses a format the server would refuse, before uploading anything', async () => {
		const { wrapper, calls, toasts } = mountCard({ logoUrl: null, logoDarkUrl: null });
		await choose(wrapper, 'light', new File(['GIF89a'], 'logo.gif', { type: 'image/gif' }));
		expect(calls).toEqual([]);
		expect(toasts).toEqual([{ message: 'Choose a PNG, JPEG or SVG file.', type: 'error' }]);
	});

	it('refuses a file over the size limit, before uploading anything', async () => {
		const { wrapper, calls, toasts } = mountCard({ logoUrl: null, logoDarkUrl: null });
		const big = new File([new Uint8Array(MAX_WORKSPACE_LOGO_BYTES + 1)], 'logo.png', {
			type: 'image/png',
		});
		await choose(wrapper, 'light', big);
		expect(calls).toEqual([]);
		expect(toasts).toEqual([{ message: 'A logo can be at most 512 KB.', type: 'error' }]);
	});

	it('removes a logo', async () => {
		const { wrapper, calls } = mountCard({ logoUrl: LOGO, logoDarkUrl: null });
		const remove = wrapper
			.get('[data-testid="workspace-logo-slot-light"]')
			.findAll('button')
			.find((b) => b.text() === 'Remove')!;
		await remove.trigger('click');
		await flushPromises();
		expect(calls).toEqual([{ fn: 'workspaces/branding:removeLogo', args: { variant: 'light' } }]);
	});

	it('keeps the dark slot closed until there is a main logo', () => {
		const { wrapper } = mountCard({ logoUrl: null, logoDarkUrl: null });
		const dark = wrapper.get('[data-testid="workspace-logo-slot-dark"]');
		expect(dark.text()).toContain('Upload the main logo first.');
		const upload = dark.findAll('button').find((b) => b.text() === 'Upload')!;
		expect(upload.attributes('disabled')).toBeDefined();
	});
});
