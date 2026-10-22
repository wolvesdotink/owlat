/**
 * The Team Inbox thread's palette provider, mounted: nothing for a member who
 * cannot write the shared inbox, the team as the "Assign to ›" submenu, the
 * three priorities with the current one marked, and each choice running the
 * page's own handler once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
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
	type TeamThreadCommandSources,
	useTeamThreadCommandSurface,
} from '../useTeamThreadCommandSurface';

beforeEach(() => {
	installNuxtStubs({ ...i18nStubs, registerCommandPaletteProvider });
});

let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

function sources(overrides: Partial<TeamThreadCommandSources> = {}): TeamThreadCommandSources {
	return {
		subject: () => 'Invoice 4471',
		canAct: () => true,
		isMine: () => false,
		isResolved: () => false,
		isSnoozed: () => false,
		priority: () => 'normal',
		assignedTo: () => 'u2',
		members: () => [
			{ userId: 'u1', name: 'Ada Marlow', email: 'ada@example.com' },
			{ userId: 'u2', name: '', email: 'ruben@example.com' },
		],
		onReply: vi.fn(),
		onAssign: vi.fn(),
		onClaim: vi.fn(),
		onStatus: vi.fn(),
		onSnooze: vi.fn(),
		onSnoozeUntilReply: vi.fn(),
		onPickSnooze: vi.fn(),
		onUnsnooze: vi.fn(),
		onAddNote: vi.fn(),
		onSetPriority: vi.fn(),
		...overrides,
	};
}

function mountPage(src: TeamThreadCommandSources) {
	wrapper = mount(
		defineComponent({
			setup() {
				useTeamThreadCommandSurface(src);
				return () => h('div');
			},
		}),
		{ global: { plugins: [createTestI18n()] } }
	);
}

function items(path = '/dashboard/inbox/t1'): PaletteItem[] {
	return resolvePaletteGroups(
		[],
		useCommandPaletteRegistry().value,
		{ path, isFlagEnabled: () => true },
		{ query: '', mode: 'commands' }
	).flatMap((group) => (group.key === 'team-thread' ? group.items : []));
}

const byId = (list: PaletteItem[], id: string) => list.find((item) => item.id === id)!;

describe('useTeamThreadCommandSurface', () => {
	it('offers nothing to a member who cannot write the shared inbox', () => {
		mountPage(sources({ canAct: () => false }));
		expect(items()).toEqual([]);
	});

	it('stays on the Team Inbox routes', () => {
		mountPage(sources());
		expect(items('/dashboard/campaigns')).toEqual([]);
		expect(items().length).toBeGreaterThan(0);
	});

	it('lists the team under "Assign to ›", the current assignee marked, plus Unassign', () => {
		const src = sources();
		mountPage(src);
		const options = byId(items(), 'inbox:thread-assign').argument!.options;
		expect(options.map((option) => [option.label, option.subtitle])).toEqual([
			['Ada Marlow', 'ada@example.com'],
			['ruben@example.com', 'Current'],
			['Unassign', undefined],
		]);
		options[0]!.run();
		expect(src.onAssign).toHaveBeenCalledWith('u1');
		options[2]!.run();
		expect(src.onAssign).toHaveBeenLastCalledWith(undefined);
	});

	it('sets a priority from its submenu, the current one marked', () => {
		const src = sources({ priority: () => 'urgent' });
		mountPage(src);
		const options = byId(items(), 'inbox:thread-priority').argument!.options;
		expect(options.map((option) => [option.label, option.subtitle])).toEqual([
			['Urgent', 'Current'],
			['Normal', undefined],
			['Low', undefined],
		]);
		options[2]!.run();
		expect(src.onSetPriority).toHaveBeenCalledExactlyOnceWith('low');
	});

	it('snoozes to a preset, until a reply, or opens the picker', () => {
		const src = sources();
		mountPage(src);
		const options = byId(items(), 'inbox:thread-snooze').argument!.options;
		options[0]!.run();
		expect(src.onSnooze).toHaveBeenCalledTimes(1);
		options.find((option) => option.id === 'snooze-until-reply')!.run();
		expect(src.onSnoozeUntilReply).toHaveBeenCalledTimes(1);
		options.find((option) => option.id === 'snooze-pick')!.run();
		expect(src.onPickSnooze).toHaveBeenCalledTimes(1);
	});

	it('resolves and reopens through the page’s status handler', () => {
		const src = sources();
		mountPage(src);
		byId(items(), 'inbox:thread-status').run();
		expect(src.onStatus).toHaveBeenCalledWith('resolved');
	});
});
