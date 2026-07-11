import { describe, it, expect, vi } from 'vitest';
import { reactive } from 'vue';
import { useRouteId } from '../useRouteId';

/**
 * Stub the Nuxt-auto-imported `useRoute` with a fixed params bag so we can
 * exercise the narrowing logic in `useRouteId` directly. Each test re-stubs it,
 * so no teardown is needed (and `unstubAllGlobals` would wipe the `computed`
 * auto-import the shared setup file provides).
 */
function stubRouteParams(params: Record<string, string | string[] | undefined>) {
	vi.stubGlobal('useRoute', () => ({ params }));
}

describe('useRouteId', () => {
	it('returns the string value of the default "id" param', () => {
		stubRouteParams({ id: 'camp_123' });
		const id = useRouteId('id');
		expect(id.value).toBe('camp_123');
	});

	it('reads a named param other than "id"', () => {
		stubRouteParams({ roomId: 'room_9' });
		const id = useRouteId('roomId');
		expect(id.value).toBe('room_9');
	});

	it('takes the first element when the param is an array', () => {
		stubRouteParams({ id: ['first', 'second'] });
		const id = useRouteId('id');
		expect(id.value).toBe('first');
	});

	it('narrows a missing param to an empty string', () => {
		stubRouteParams({});
		const id = useRouteId('id');
		expect(id.value).toBe('');
	});

	it('narrows an empty array param to an empty string', () => {
		stubRouteParams({ id: [] });
		const id = useRouteId('id');
		expect(id.value).toBe('');
	});

	it('stays reactive when the underlying param changes', () => {
		const route = reactive({ params: { id: 'a' } as Record<string, string | string[]> });
		vi.stubGlobal('useRoute', () => route);
		const id = useRouteId('id');
		expect(id.value).toBe('a');
		route.params.id = 'b';
		expect(id.value).toBe('b');
	});
});
