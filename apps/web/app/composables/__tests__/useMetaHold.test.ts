import { describe, expect, it } from 'vitest';
import { useMetaHold } from '../useMetaHold';

function key(k: string): KeyboardEvent {
	return { key: k } as KeyboardEvent;
}

describe('useMetaHold', () => {
	it('reveals while Meta is held and hides on release', () => {
		const { held, onKeydown, onKeyup } = useMetaHold();
		expect(held.value).toBe(false);

		onKeydown(key('Meta'));
		expect(held.value).toBe(true);

		// Repeated keydown (auto-repeat) keeps it held, not toggled.
		onKeydown(key('Meta'));
		expect(held.value).toBe(true);

		onKeyup(key('Meta'));
		expect(held.value).toBe(false);
	});

	it('ignores non-Meta keys', () => {
		const { held, onKeydown, onKeyup } = useMetaHold();
		onKeydown(key('Control'));
		onKeydown(key('a'));
		expect(held.value).toBe(false);

		onKeydown(key('Meta'));
		onKeyup(key('Shift'));
		expect(held.value).toBe(true);
	});

	it('reset clears a stuck hold (e.g. window blur after ⌘-Tab)', () => {
		const { held, onKeydown, reset } = useMetaHold();
		onKeydown(key('Meta'));
		expect(held.value).toBe(true);
		reset();
		expect(held.value).toBe(false);
	});
});
