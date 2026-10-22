/**
 * Conformance pins for the Postbox command-palette provider descriptor.
 *
 * The provider is registered from inside a composable at mount time, so its
 * static contract (id, external-tier priority, route gate) is exported and
 * pinned here without mounting the Postbox layout. If a refactor renames the id,
 * changes the priority, or loosens the route gate to a bare prefix match, one of
 * these assertions fails.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { PaletteItem } from '~/lib/commandPalette';
import { resolvePaletteGroups } from '~/lib/commandPaletteRegistry';
import {
	registerCommandPaletteProvider,
	useCommandPaletteRegistry,
} from '~/composables/useCommandPaletteRegistry';
import {
	POSTBOX_COMMAND_PROVIDER_ID,
	POSTBOX_COMMAND_PROVIDER_PRIORITY,
	matchPostboxRoute,
	usePostboxCommandSurface,
} from '../usePostboxCommandSurface';

describe('Postbox command provider descriptor', () => {
	it('keeps its stable registry id and external-tier priority', () => {
		expect(POSTBOX_COMMAND_PROVIDER_ID).toBe('surface:postbox');
		expect(POSTBOX_COMMAND_PROVIDER_PRIORITY).toBe(15);
	});

	it('gates on the Postbox surface exactly or a nested child, not siblings', () => {
		expect(matchPostboxRoute('/dashboard/postbox')).toBe(true);
		expect(matchPostboxRoute('/dashboard/postbox/inbox')).toBe(true);
		expect(matchPostboxRoute('/dashboard/postbox-archive')).toBe(false);
		expect(matchPostboxRoute('/dashboard/campaigns')).toBe(false);
	});
});

describe('Postbox command provider — "Switch mailbox ›"', () => {
	const switchToMailbox = vi.fn();
	let wrapper: VueWrapper | null = null;
	afterEach(() => {
		wrapper?.unmount();
		wrapper = null;
	});

	function mountSurface() {
		installNuxtStubs({
			...i18nStubs,
			registerCommandPaletteProvider,
			usePostboxComposeNav: () => ({ open: vi.fn() }),
			useDesktopContext: () => ({ isDesktop: ref(false) }),
			usePostboxLabels: () => ({ labels: ref([]) }),
			usePostboxMailbox: () => ({
				sections: ref({
					personal: [
						{ mailboxId: 'mb-ada', label: 'ada@example.com' },
						{ mailboxId: 'mb-alias', label: 'hello@example.com' },
					],
					team: [{ mailboxId: 'mb-support', label: 'Support' }],
				}),
				switchToMailbox,
			}),
		});
		wrapper = mount(
			defineComponent({
				setup() {
					usePostboxCommandSurface(ref('mb-ada') as never);
					return () => h('div');
				},
			}),
			{ global: { plugins: [createTestI18n()] } }
		);
	}

	function switchRows(query: string): PaletteItem[] {
		return resolvePaletteGroups(
			[],
			useCommandPaletteRegistry().value,
			{ path: '/dashboard/postbox/inbox', isFlagEnabled: () => true },
			{ query, mode: 'commands' }
		).flatMap((group) => (group.key === 'postbox-switch-mailbox' ? group.items : []));
	}

	it('is one row with every mailbox in its submenu', () => {
		mountSurface();
		const rows = switchRows('');
		expect(rows.map((row) => row.label)).toEqual(['Switch mailbox…']);
		const options = rows[0]!.argument!.options;
		expect(options.map((option) => option.label)).toEqual([
			'ada@example.com',
			'hello@example.com',
			'Support',
		]);
		options[2]!.run();
		expect(switchToMailbox).toHaveBeenCalledWith('mb-support');
	});

	it('also lists a typed-for mailbox directly, one Enter away', () => {
		mountSurface();
		expect(switchRows('support').map((row) => row.label)).toEqual(['Go to Support (team inbox)']);
	});
});
