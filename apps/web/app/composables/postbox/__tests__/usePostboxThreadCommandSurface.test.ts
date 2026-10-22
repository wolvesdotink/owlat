/**
 * The open conversation's palette provider, mounted: it answers only for the
 * reader on top (two can be up at once), its rows run THIS reader's actions,
 * its submenus carry the reader's labels, folders and snooze times, and the
 * conversation lands in the palette's "Jump back" list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { PaletteGroup, PaletteItem } from '~/lib/commandPalette';
import { resolvePaletteGroups } from '~/lib/commandPaletteRegistry';
import {
	registerCommandPaletteProvider,
	useCommandPaletteRegistry,
} from '~/composables/useCommandPaletteRegistry';
import { useCopyToClipboard } from '~/composables/useCopyToClipboard';
import { useCommandPaletteObjectRecents } from '~/composables/useCommandPaletteObjectRecents';
import {
	type PostboxThreadCommandSources,
	usePostboxThreadCommandSurface,
} from '../usePostboxThreadCommandSurface';

const showToast = vi.fn();
const routePath = { value: '/dashboard/postbox/inbox/m1' };

beforeEach(() => {
	localStorage.clear();
	showToast.mockClear();
	installNuxtStubs({
		...i18nStubs,
		registerCommandPaletteProvider,
		useCopyToClipboard,
		useRoute: () => ({ path: routePath.value }),
		useToast: () => ({ showToast }),
		usePostboxActiveMailbox: () => ({ setActiveMailboxId: vi.fn() }),
		navigateTo: vi.fn(),
	});
});

const mounted: VueWrapper[] = [];
afterEach(() => {
	while (mounted.length) mounted.pop()!.unmount();
});

function sources(
	overrides: Partial<PostboxThreadCommandSources> = {}
): PostboxThreadCommandSources {
	return {
		subject: () => 'Invoice 4471',
		messageId: () => 'm1',
		threadId: () => 't1',
		mailboxId: () => 'mb1',
		href: () => '/dashboard/postbox/inbox/m1',
		hintText: () => 'Invoice 4471',
		isMuted: () => false,
		isAlerted: () => false,
		followUp: () => ({ state: 'none' }),
		canTranslate: () => true,
		labels: () => [{ _id: 'l1', name: 'Work' }],
		folders: () => [
			{ _id: 'f1', name: 'Archive', role: 'archive' },
			{ _id: 'f2', name: 'Receipts' },
		],
		runAction: vi.fn(),
		snooze: vi.fn(),
		snoozeUntilReply: vi.fn(),
		applyLabel: vi.fn(),
		moveTo: vi.fn(),
		toggleMute: vi.fn(),
		toggleAlert: vi.fn(),
		translate: vi.fn(),
		...overrides,
	};
}

function mountReader(src: PostboxThreadCommandSources): VueWrapper {
	const wrapper = mount(
		defineComponent({
			setup() {
				usePostboxThreadCommandSurface(src);
				return () => h('div');
			},
		}),
		{ global: { plugins: [createTestI18n()] } }
	);
	mounted.push(wrapper);
	return wrapper;
}

function threadGroup(query = ''): PaletteGroup | undefined {
	return resolvePaletteGroups(
		[],
		useCommandPaletteRegistry().value,
		{ path: routePath.value, isFlagEnabled: () => true },
		{ query, mode: 'commands' }
	).find((group) => group.key === 'postbox-thread' && group.items.length > 0);
}

function row(id: string, query = ''): PaletteItem {
	const found = threadGroup(query)?.items.find((item) => item.id === id);
	if (!found) throw new Error(`no row ${id}`);
	return found;
}

describe('usePostboxThreadCommandSurface', () => {
	it('runs the verbs on this reader', () => {
		const src = sources();
		mountReader(src);
		row('postbox:thread-reply').run();
		row('postbox:thread-mark-unread').run();
		row('postbox:forward').run();
		row('postbox:thread-translate').run();
		expect(src.runAction).toHaveBeenNthCalledWith(1, 'reply');
		expect(src.runAction).toHaveBeenNthCalledWith(2, 'markUnread');
		expect(src.runAction).toHaveBeenNthCalledWith(3, 'forward');
		expect(src.translate).toHaveBeenCalledTimes(1);
	});

	it('fills the submenus from the reader: labels, folders by name, snooze times', () => {
		const src = sources();
		mountReader(src);
		const move = row('postbox:move').argument!;
		expect(move.options.map((option) => option.label)).toEqual(['Archive', 'Receipts']);
		move.options[1]!.run();
		expect(src.moveTo).toHaveBeenCalledWith('f2');

		row('postbox:label-as').argument!.options[0]!.run();
		expect(src.applyLabel).toHaveBeenCalledWith('l1');

		const snooze = row('postbox:thread-snooze').argument!.options;
		expect(snooze.length).toBeGreaterThan(2);
		snooze[0]!.run();
		expect(src.snooze).toHaveBeenCalledTimes(1);
		expect(vi.mocked(src.snooze).mock.calls[0]![0]).toBeGreaterThan(Date.now());
		snooze.find((option) => option.id === 'snooze-until-reply')!.run();
		expect(src.snoozeUntilReply).toHaveBeenCalledTimes(1);
		snooze.find((option) => option.id === 'snooze-pick')!.run();
		expect(src.runAction).toHaveBeenCalledWith('snooze');
	});

	it('answers only for the reader mounted last, and hands back when it goes', async () => {
		const below = sources();
		const above = sources({ subject: () => 'Overlay thread' });
		// One app, like the folder reader and the Today overlay above it.
		const Reader = defineComponent({
			props: { src: { type: Object, required: true } },
			setup(props) {
				usePostboxThreadCommandSurface(props.src as PostboxThreadCommandSources);
				return () => h('div');
			},
		});
		const showOverlay = ref(true);
		mounted.push(
			mount(
				defineComponent({
					setup: () => () => [
						h(Reader, { src: below }),
						showOverlay.value ? h(Reader, { src: above }) : null,
					],
				}),
				{ global: { plugins: [createTestI18n()] } }
			)
		);

		expect(threadGroup()?.items[0]?.subtitle).toBe('Overlay thread');
		row('postbox:thread-archive').run();
		expect(above.runAction).toHaveBeenCalledWith('archive');
		expect(below.runAction).not.toHaveBeenCalled();

		showOverlay.value = false;
		await nextTick();
		row('postbox:thread-archive').run();
		expect(below.runAction).toHaveBeenCalledWith('archive');
	});

	it('copies an absolute link to the conversation', async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		mountReader(sources());
		row('postbox:thread-copy-link').run();
		await nextTick();
		await nextTick();
		expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/dashboard/postbox/inbox/m1`);
		expect(showToast).toHaveBeenCalledWith('Link copied');
	});

	it('records the conversation for Jump back, but not as the place to jump to while open', () => {
		const reader = mountReader(sources());
		let recents!: ReturnType<typeof useCommandPaletteObjectRecents>;
		mounted.push(
			mount(
				defineComponent({
					setup() {
						recents = useCommandPaletteObjectRecents();
						return () => h('div');
					},
				}),
				{ global: { plugins: [createTestI18n()] } }
			)
		);
		recents.load();
		expect(recents.jumpBackItems.value).toEqual([]);
		expect(recents.recencyOf('t1')).toBeGreaterThan(0);
		expect(recents.recencyOf('m1')).toBe(recents.recencyOf('t1'));

		reader.unmount();
		mounted.splice(mounted.indexOf(reader), 1);
		expect(recents.jumpBackItems.value.map((item) => [item.label, item.subtitle])).toEqual([
			['Invoice 4471', 'Conversation'],
		]);
	});
});
