/**
 * Dropping files on a conversation: the row/reader directive, the shell host
 * that queues the files and opens Answer mode, and the Answer mode page that
 * takes them. Everything runs on synthetic drag events and deferred promises;
 * nothing waits on a clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, nextTick, ref, withDirectives, type Ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ReplyDropRef, ReplyDropTarget } from '~/utils/replyFileDrop';
import type * as ReplyFileDrop from '../useReplyFileDrop';

const open = vi.fn();
const openTeam = vi.fn();
vi.mock('~/composables/useAnswerMode', () => ({
	useAnswerModeNav: () => ({ open, openTeam }),
}));

const isDesktop = ref(false);
vi.mock('~/composables/useDesktopContext', () => ({
	useDesktopContext: () => ({ isDesktop }),
}));

const claimed = vi.fn(() => false);
vi.mock('~/composables/useDropZone', () => ({
	osFileDropClaimed: (position: unknown) => claimed(position),
}));

type DesktopHandlers = {
	onEnter?: (count: number, position: { x: number; y: number }) => void;
	onOver?: (position: { x: number; y: number }) => void;
	onLeave?: () => void;
	onDropStart?: (position: { x: number; y: number }, dropId: number) => void;
	onDrop: (files: File[], position: { x: number; y: number }, dropId: number) => void;
};
let desktop: DesktopHandlers | null = null;
vi.mock('@owlat/desktop/src/dialog', () => ({
	onWebviewFileDrop: async (handlers: DesktopHandlers) => {
		desktop = handlers;
		return () => {
			desktop = null;
		};
	},
}));

const userId = ref<string | null>('user-1');
const orgId = ref<string | null>('org-1');

let mod: typeof ReplyFileDrop;
const mounted: VueWrapper[] = [];

beforeEach(async () => {
	vi.resetModules();
	open.mockReset().mockResolvedValue(undefined);
	openTeam.mockReset().mockResolvedValue(undefined);
	claimed.mockReset().mockReturnValue(false);
	isDesktop.value = false;
	desktop = null;
	userId.value = 'user-1';
	orgId.value = 'org-1';
	const user = computed(() => (userId.value ? { id: userId.value } : null));
	vi.stubGlobal('useAuth', () => ({ user, activeOrganizationId: orgId }));
	mod = await import('../useReplyFileDrop');
});

afterEach(() => {
	while (mounted.length) mounted.pop()!.unmount();
});

function track<T extends VueWrapper>(wrapper: T): T {
	mounted.push(wrapper);
	return wrapper;
}

const file = (name: string) => new File([name], name);

/** A drag event with a hand-built DataTransfer (happy-dom has none to give). */
function drag(
	type: string,
	opts: {
		types?: string[];
		files?: File[];
		count?: number;
		relatedTarget?: EventTarget | null;
	} = {}
): DragEvent {
	const files = opts.files ?? [];
	const kinds = Array.from({ length: opts.count ?? files.length }, () => ({ kind: 'file' }));
	const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
	Object.defineProperty(event, 'dataTransfer', {
		value: { types: opts.types ?? ['Files'], items: kinds, files, dropEffect: 'none' },
	});
	Object.defineProperty(event, 'relatedTarget', { value: opts.relatedTarget ?? null });
	return event;
}

function mountHost() {
	return track(
		mount(
			defineComponent({
				setup() {
					const { hover } = mod.useReplyDropHost();
					return { hover };
				},
				render: () => h('div'),
			}),
			{ attachTo: document.body }
		)
	);
}

/** A conversation row: the directive on an element, with a child inside it. */
function mountTarget(target: Ref<ReplyDropTarget | null>) {
	return track(
		mount(
			defineComponent({
				setup: () => () =>
					withDirectives(h('div', { class: 'row' }, [h('span', { class: 'child' }, 'Ines')]), [
						[mod.vReplyDrop, target.value],
					]),
			}),
			{ attachTo: document.body }
		)
	);
}

/** An Answer mode page: takes files for `target` once `ready`. */
function mountAnswer(opts: {
	target: Ref<ReplyDropRef | null>;
	ready: Ref<boolean>;
	refused?: Ref<boolean>;
	onRefused?: () => void;
}) {
	const received: File[][] = [];
	const wrapper = track(
		mount(
			defineComponent({
				setup() {
					mod.useReplyDropDelivery({
						target: () => opts.target.value,
						deliver: () => (opts.ready.value ? (files: File[]) => received.push(files) : null),
						refused: () => opts.refused?.value ?? false,
						onRefused: opts.onRefused,
					});
					return () => h('div');
				},
			})
		)
	);
	return { wrapper, received };
}

const ines: ReplyDropTarget = { kind: 'message', id: 'm1', recipient: 'Ines' };

describe('the conversation drop target', () => {
	it('shows the hint for a file drag and names the files', async () => {
		const host = mountHost();
		const row = mountTarget(ref(ines));
		const event = drag('dragover', { count: 2 });
		row.element.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(host.vm.hover).toMatchObject({ target: { id: 'm1', recipient: 'Ines' }, count: 2 });
	});

	it('leaves text and the list’s own drags alone', () => {
		const host = mountHost();
		const row = mountTarget(ref(ines));
		for (const types of [['text/plain'], ['application/x-owlat-messages']]) {
			const event = drag('dragover', { types });
			row.element.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(false);
		}
		const drop = drag('drop', { types: ['text/plain'], files: [file('a')] });
		row.element.dispatchEvent(drop);
		expect(host.vm.hover).toBeNull();
		expect(open).not.toHaveBeenCalled();
	});

	it('stays lit while the pointer moves onto a child, and goes out on leaving', () => {
		const host = mountHost();
		const row = mountTarget(ref(ines));
		row.element.dispatchEvent(drag('dragover', { count: 1 }));
		const child = row.element.querySelector('.child')!;
		row.element.dispatchEvent(drag('dragleave', { relatedTarget: child }));
		expect(host.vm.hover).not.toBeNull();
		row.element.dispatchEvent(drag('dragleave', { relatedTarget: document.body }));
		expect(host.vm.hover).toBeNull();
	});

	it('stands aside where an inner drop zone (a composer) took the drag', () => {
		const host = mountHost();
		const row = mountTarget(ref(ines));
		const child = row.element.querySelector('.child')!;
		child.addEventListener('dragover', (e) => e.preventDefault());
		child.addEventListener('drop', (e) => e.preventDefault());
		child.dispatchEvent(drag('dragover', { count: 1 }));
		expect(host.vm.hover).toBeNull();
		child.dispatchEvent(drag('drop', { files: [file('a')] }));
		expect(open).not.toHaveBeenCalled();
	});

	it('is inert where the conversation takes no drop', () => {
		mountHost();
		const target = ref<ReplyDropTarget | null>(null);
		const row = mountTarget(target);
		const event = drag('dragover', { count: 1 });
		row.element.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		expect(row.element.hasAttribute('data-reply-drop')).toBe(false);
	});

	it('answers for the conversation a recycled row shows now', async () => {
		mountHost();
		const target = ref<ReplyDropTarget | null>(ines);
		const row = mountTarget(target);
		target.value = { kind: 'message', id: 'm2', recipient: 'Jonas' };
		await nextTick();
		row.element.dispatchEvent(drag('drop', { files: [file('a')] }));
		expect(open).toHaveBeenCalledWith('m2', { kind: null });
	});

	it('writes its marker only when the row starts or stops taking drops', async () => {
		mountHost();
		const target = ref<ReplyDropTarget | null>(ines);
		const row = mountTarget(target);
		const el = row.element as HTMLElement;
		const set = vi.spyOn(el, 'setAttribute');
		const remove = vi.spyOn(el, 'removeAttribute');

		target.value = { kind: 'message', id: 'm2', recipient: 'Jonas' };
		await nextTick();
		expect(set).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(el.hasAttribute('data-reply-drop')).toBe(true);
		el.dispatchEvent(drag('drop', { files: [file('a')] }));
		expect(open).toHaveBeenCalledWith('m2', { kind: null });

		target.value = null;
		await nextTick();
		expect(el.hasAttribute('data-reply-drop')).toBe(false);
		const ignored = drag('dragover', { count: 1 });
		el.dispatchEvent(ignored);
		expect(ignored.defaultPrevented).toBe(false);

		target.value = ines;
		await nextTick();
		expect(set).toHaveBeenCalledTimes(1);
		expect(el.hasAttribute('data-reply-drop')).toBe(true);
	});
});

describe('a drop, through to Answer mode', () => {
	it('opens Answer mode and attaches both files exactly once', async () => {
		mountHost();
		const row = mountTarget(ref({ ...ines, replyKind: 'replyAll' as const }));
		const [a, b] = [file('a.pdf'), file('b.csv')];
		row.element.dispatchEvent(drag('drop', { files: [a, b] }));
		await flushPromises();
		expect(open).toHaveBeenCalledWith('m1', { kind: 'replyAll' });

		const ready = ref(false);
		const page = mountAnswer({ target: ref({ kind: 'message', id: 'm1' }), ready });
		await flushPromises();
		// The composer is not up yet: nothing is handed over early.
		expect(page.received).toEqual([]);
		ready.value = true;
		await nextTick();
		expect(page.received).toEqual([[a, b]]);
		ready.value = false;
		await nextTick();
		ready.value = true;
		await nextTick();
		expect(page.received).toHaveLength(1);
	});

	it('opens a Team inbox thread, on the message the target names', async () => {
		mountHost();
		const row = mountTarget(
			ref<ReplyDropTarget>({
				kind: 'team',
				id: 't1',
				recipient: 'ines@example.com',
				messageId: 'in1',
			})
		);
		const a = file('a');
		row.element.dispatchEvent(drag('drop', { files: [a] }));
		await flushPromises();
		expect(openTeam).toHaveBeenCalledWith('t1', { messageId: 'in1' });
		const page = mountAnswer({ target: ref({ kind: 'team', id: 't1' }), ready: ref(true) });
		expect(page.received).toEqual([[a]]);
	});

	it('hands files to the page that is already up when they arrive', async () => {
		mountHost();
		const page = mountAnswer({ target: ref({ kind: 'message', id: 'm1' }), ready: ref(true) });
		const row = mountTarget(ref(ines));
		const a = file('a');
		row.element.dispatchEvent(drag('drop', { files: [a] }));
		await nextTick();
		expect(page.received).toEqual([[a]]);
	});

	it('never gives one conversation’s files to another', async () => {
		mountHost();
		const row = mountTarget(ref(ines));
		row.element.dispatchEvent(drag('drop', { files: [file('a')] }));
		await flushPromises();
		const other = mountAnswer({ target: ref({ kind: 'message', id: 'm2' }), ready: ref(true) });
		const team = mountAnswer({ target: ref({ kind: 'team', id: 'm1' }), ready: ref(true) });
		expect(other.received).toEqual([]);
		expect(team.received).toEqual([]);
		const mine = mountAnswer({ target: ref({ kind: 'message', id: 'm1' }), ready: ref(true) });
		expect(mine.received).toHaveLength(1);
	});

	it('drops the files when the navigation does not land', async () => {
		mountHost();
		open.mockResolvedValueOnce(false);
		const row = mountTarget(ref(ines));
		row.element.dispatchEvent(drag('drop', { files: [file('a')] }));
		await flushPromises();
		const page = mountAnswer({ target: ref({ kind: 'message', id: 'm1' }), ready: ref(true) });
		expect(page.received).toEqual([]);
	});

	it('drops the files when the navigation throws', async () => {
		mountHost();
		open.mockRejectedValueOnce(new Error('chunk failed'));
		const row = mountTarget(ref(ines));
		row.element.dispatchEvent(drag('drop', { files: [file('a')] }));
		await flushPromises();
		const page = mountAnswer({ target: ref({ kind: 'message', id: 'm1' }), ready: ref(true) });
		expect(page.received).toEqual([]);
	});

	it('queues nothing until the reply guard lets the reply open', async () => {
		mountHost();
		let proceed: (() => void) | null = null;
		const row = mountTarget(ref({ ...ines, guard: (run: () => void) => (proceed = run) }));
		const a = file('a');
		row.element.dispatchEvent(drag('drop', { files: [a] }));
		await flushPromises();
		expect(open).not.toHaveBeenCalled();
		// A guard that is cancelled never proceeds: a later visit finds nothing.
		const early = mountAnswer({ target: ref({ kind: 'message', id: 'm1' }), ready: ref(true) });
		expect(early.received).toEqual([]);
		early.wrapper.unmount();
		mounted.splice(mounted.indexOf(early.wrapper), 1);

		proceed!();
		await flushPromises();
		expect(open).toHaveBeenCalledOnce();
		const page = mountAnswer({ target: ref({ kind: 'message', id: 'm1' }), ready: ref(true) });
		expect(page.received).toEqual([[a]]);
	});

	it('drops a guarded reply whose guard proceeds after the workspace changed', async () => {
		mountHost();
		let proceed: (() => void) | null = null;
		const row = mountTarget(ref({ ...ines, guard: (run: () => void) => (proceed = run) }));
		row.element.dispatchEvent(drag('drop', { files: [file('a')] }));
		orgId.value = 'org-2';
		proceed!();
		await flushPromises();
		expect(open).not.toHaveBeenCalled();
		const page = mountAnswer({ target: ref({ kind: 'message', id: 'm1' }), ready: ref(true) });
		expect(page.received).toEqual([]);
	});

	it('drops a guarded reply whose guard proceeds after the shell went away', async () => {
		const host = mountHost();
		let proceed: (() => void) | null = null;
		const row = mountTarget(ref({ ...ines, guard: (run: () => void) => (proceed = run) }));
		row.element.dispatchEvent(drag('drop', { files: [file('a')] }));
		host.unmount();
		mounted.splice(mounted.indexOf(host), 1);
		proceed!();
		await flushPromises();
		expect(open).not.toHaveBeenCalled();
	});

	it('forgets what waits when the account or workspace changes', async () => {
		mountHost();
		const row = mountTarget(ref(ines));
		row.element.dispatchEvent(drag('drop', { files: [file('a')] }));
		await flushPromises();
		orgId.value = 'org-2';
		await nextTick();
		const page = mountAnswer({ target: ref({ kind: 'message', id: 'm1' }), ready: ref(true) });
		expect(page.received).toEqual([]);
	});

	it('forgets what the page did not take when it is left', async () => {
		mountHost();
		const row = mountTarget(ref(ines));
		row.element.dispatchEvent(drag('drop', { files: [file('a')] }));
		await flushPromises();
		const first = mountAnswer({ target: ref({ kind: 'message', id: 'm1' }), ready: ref(false) });
		first.wrapper.unmount();
		mounted.splice(mounted.indexOf(first.wrapper), 1);
		const again = mountAnswer({ target: ref({ kind: 'message', id: 'm1' }), ready: ref(true) });
		expect(again.received).toEqual([]);
	});

	it('forgets what the page did not take when it moves to another conversation', async () => {
		mountHost();
		const row = mountTarget(ref(ines));
		row.element.dispatchEvent(drag('drop', { files: [file('a')] }));
		await flushPromises();
		const target = ref<ReplyDropRef | null>({ kind: 'message', id: 'm1' });
		const ready = ref(false);
		const page = mountAnswer({ target, ready });
		target.value = { kind: 'message', id: 'm9' };
		await nextTick();
		target.value = { kind: 'message', id: 'm1' };
		ready.value = true;
		await nextTick();
		expect(page.received).toEqual([]);
	});

	it('turns the files away, once, where the reply cannot carry them', async () => {
		mountHost();
		const row = mountTarget(ref<ReplyDropTarget>({ kind: 'team', id: 't1', recipient: '+49 151' }));
		row.element.dispatchEvent(drag('drop', { files: [file('a')] }));
		await flushPromises();
		const onRefused = vi.fn();
		const refused = ref(false);
		const ready = ref(false);
		const page = mountAnswer({
			target: ref({ kind: 'team', id: 't1' }),
			ready,
			refused,
			onRefused,
		});
		refused.value = true;
		await nextTick();
		expect(onRefused).toHaveBeenCalledOnce();
		ready.value = true;
		refused.value = false;
		await nextTick();
		expect(page.received).toEqual([]);
		expect(onRefused).toHaveBeenCalledOnce();
	});
});

describe('desktop window drops', () => {
	let rowEl: HTMLElement;
	let otherEl: HTMLElement;
	let hit: Element | null;

	beforeEach(() => {
		isDesktop.value = true;
		hit = null;
		Object.defineProperty(document, 'elementFromPoint', {
			configurable: true,
			value: vi.fn(() => hit),
		});
	});

	async function setup() {
		const host = mountHost();
		await flushPromises();
		rowEl = mountTarget(ref(ines)).element as HTMLElement;
		otherEl = mountTarget(ref<ReplyDropTarget>({ kind: 'message', id: 'm2', recipient: 'Jonas' }))
			.element as HTMLElement;
		expect(desktop).not.toBeNull();
		return host;
	}

	it('places the hint by window position with the count the drag entered with', async () => {
		const host = await setup();
		hit = rowEl.querySelector('.child');
		desktop!.onEnter?.(3, { x: 10, y: 10 });
		desktop!.onOver?.({ x: 10, y: 10 });
		expect(host.vm.hover).toMatchObject({ target: { id: 'm1' }, count: 3 });
		desktop!.onLeave?.();
		expect(host.vm.hover).toBeNull();
	});

	it('sends the files where the drop landed, even if the page changes during the read', async () => {
		await setup();
		hit = rowEl;
		desktop!.onDropStart?.({ x: 10, y: 10 }, 1);
		// The list re-rendered while the files were read off disk.
		hit = otherEl;
		const a = file('a');
		desktop!.onDrop([a], { x: 10, y: 10 }, 1);
		await flushPromises();
		expect(open).toHaveBeenCalledWith('m1', { kind: null });
		expect(open).toHaveBeenCalledOnce();
	});

	it('leaves a drop a composer or an open upload modal takes', async () => {
		const host = await setup();
		claimed.mockReturnValue(true);
		hit = rowEl;
		desktop!.onOver?.({ x: 10, y: 10 });
		expect(host.vm.hover).toBeNull();
		desktop!.onDropStart?.({ x: 10, y: 10 }, 1);
		desktop!.onDrop([file('a')], { x: 10, y: 10 }, 1);
		await flushPromises();
		expect(open).not.toHaveBeenCalled();
	});

	it('ignores a drop outside any conversation', async () => {
		await setup();
		hit = document.body;
		desktop!.onDropStart?.({ x: 10, y: 10 }, 1);
		desktop!.onDrop([file('a')], { x: 10, y: 10 }, 1);
		await flushPromises();
		expect(open).not.toHaveBeenCalled();
	});

	it('keeps overlapping drops apart, whichever read finishes first', async () => {
		await setup();
		hit = rowEl;
		desktop!.onDropStart?.({ x: 10, y: 10 }, 1);
		hit = otherEl;
		desktop!.onDropStart?.({ x: 10, y: 40 }, 2);
		const [first, second] = [file('first.pdf'), file('second.pdf')];
		// The first drop's read finishes first, then the second's.
		desktop!.onDrop([first], { x: 10, y: 10 }, 1);
		desktop!.onDrop([second], { x: 10, y: 40 }, 2);
		await flushPromises();
		expect(open.mock.calls).toEqual([
			['m1', { kind: null }],
			['m2', { kind: null }],
		]);
		const toInes = mountAnswer({ target: ref({ kind: 'message', id: 'm1' }), ready: ref(true) });
		const toJonas = mountAnswer({ target: ref({ kind: 'message', id: 'm2' }), ready: ref(true) });
		expect(toInes.received).toEqual([[first]]);
		expect(toJonas.received).toEqual([[second]]);
	});

	it('keeps overlapping drops apart when the later read finishes first', async () => {
		await setup();
		hit = rowEl;
		desktop!.onDropStart?.({ x: 10, y: 10 }, 1);
		hit = otherEl;
		desktop!.onDropStart?.({ x: 10, y: 40 }, 2);
		const [first, second] = [file('first.pdf'), file('second.pdf')];
		desktop!.onDrop([second], { x: 10, y: 40 }, 2);
		desktop!.onDrop([first], { x: 10, y: 10 }, 1);
		await flushPromises();
		expect(open.mock.calls).toEqual([
			['m2', { kind: null }],
			['m1', { kind: null }],
		]);
		const toInes = mountAnswer({ target: ref({ kind: 'message', id: 'm1' }), ready: ref(true) });
		const toJonas = mountAnswer({ target: ref({ kind: 'message', id: 'm2' }), ready: ref(true) });
		expect(toInes.received).toEqual([[first]]);
		expect(toJonas.received).toEqual([[second]]);
	});

	it('discards a drop whose read finishes after the workspace changed', async () => {
		await setup();
		hit = rowEl;
		desktop!.onDropStart?.({ x: 10, y: 10 }, 1);
		orgId.value = 'org-2';
		desktop!.onDrop([file('a')], { x: 10, y: 10 }, 1);
		await flushPromises();
		expect(open).not.toHaveBeenCalled();
		const page = mountAnswer({ target: ref({ kind: 'message', id: 'm1' }), ready: ref(true) });
		expect(page.received).toEqual([]);
	});

	it('raises no reply guard for a drop whose read finishes after the workspace changed', async () => {
		await setup();
		const guard = vi.fn();
		hit = mountTarget(ref<ReplyDropTarget>({ ...ines, guard })).element;
		desktop!.onDropStart?.({ x: 10, y: 10 }, 1);
		orgId.value = 'org-2';
		desktop!.onDrop([file('a')], { x: 10, y: 10 }, 1);
		await flushPromises();
		expect(guard).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
	});

	it('discards a drop whose read finishes after the account changed', async () => {
		await setup();
		hit = rowEl;
		desktop!.onDropStart?.({ x: 10, y: 10 }, 1);
		userId.value = 'user-2';
		// A drop that lands in the new session still goes through.
		desktop!.onDropStart?.({ x: 10, y: 10 }, 2);
		desktop!.onDrop([file('stale')], { x: 10, y: 10 }, 1);
		const fresh = file('fresh');
		desktop!.onDrop([fresh], { x: 10, y: 10 }, 2);
		await flushPromises();
		expect(open).toHaveBeenCalledOnce();
		const page = mountAnswer({ target: ref({ kind: 'message', id: 'm1' }), ready: ref(true) });
		expect(page.received).toEqual([[fresh]]);
	});

	it('discards a drop whose read finishes after the shell went away', async () => {
		const host = await setup();
		const bridge = desktop!;
		hit = rowEl;
		bridge.onDropStart?.({ x: 10, y: 10 }, 1);
		host.unmount();
		mounted.splice(mounted.indexOf(host), 1);
		expect(desktop).toBeNull();
		// A completion already on its way still reaches the old handlers.
		bridge.onDrop([file('a')], { x: 10, y: 10 }, 1);
		await flushPromises();
		expect(open).not.toHaveBeenCalled();
	});
});
