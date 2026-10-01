// @vitest-environment happy-dom
/**
 * Esc in the composer minimizes the popup (Answer mode: lets go of the
 * editor), unless something inside the composer owns the press. A popover
 * that already closed on it and claimed it (the footer's ⋯) is such an owner:
 * one press, one thing closes.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { usePostboxComposerKeys } from '../usePostboxComposerKeys';

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: () => ({ t: (key: string) => key }),
		useDesktopContext: () => ({ platform: ref('linux') }),
	});
});

function setup() {
	const onMinimize = vi.fn();
	const keys = usePostboxComposerKeys({
		rootEl: ref(document.createElement('div')),
		canSend: ref(true),
		sending: ref(false),
		isScheduled: ref(false),
		scheduleOpen: ref(false),
		onSend: vi.fn(),
		onSchedule: vi.fn(),
		onMinimize,
	});
	return { ...keys, onMinimize };
}

const esc = () => new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });

describe('usePostboxComposerKeys — Esc', () => {
	it('minimizes on a plain Esc', () => {
		const { onComposerKeydown, onMinimize } = setup();
		onComposerKeydown(esc());
		expect(onMinimize).toHaveBeenCalledOnce();
	});

	it('leaves an Esc a popover already claimed alone', () => {
		const { onComposerKeydown, onMinimize } = setup();
		const event = esc();
		event.preventDefault();
		onComposerKeydown(event);
		expect(onMinimize).not.toHaveBeenCalled();
	});
});
