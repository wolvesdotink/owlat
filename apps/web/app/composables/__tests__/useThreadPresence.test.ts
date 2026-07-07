import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h, ref, nextTick, type Ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { useThreadPresence } from '../useThreadPresence';

/**
 * useThreadPresence drives a background heartbeat with two behaviours worth
 * pinning down without a live backend:
 *   1. it PAUSES while the tab is hidden (document.hidden) and resumes on show;
 *   2. it flips `mode` to `replying` the moment the editor gains focus.
 */

let wrapper: VueWrapper | null = null;
const mutation = vi.fn().mockResolvedValue({ success: true });

function setHidden(hidden: boolean) {
	Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}

function mountHost(replying: Ref<boolean>): VueWrapper {
	const Host = defineComponent({
		setup() {
			const threadId = ref('thread_1' as never);
			useThreadPresence(threadId, { replying });
			return () => h('div');
		},
	});
	wrapper = mount(Host, { attachTo: document.body });
	return wrapper;
}

beforeEach(() => {
	mutation.mockClear();
	setHidden(false);
	vi.stubGlobal('useConvex', () => ({ mutation }));
	vi.stubGlobal('useConvexQuery', () => ({ data: ref([]) }));
	vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'me' }) }));
});

afterEach(() => {
	try {
		wrapper?.unmount();
	} catch {
		// already unmounted
	}
	wrapper = null;
	// NB: do NOT call vi.unstubAllGlobals() here — it would also wipe the Vue
	// auto-import polyfills (`ref`/`computed`/…) that app/__tests__/setup.ts
	// registers via vi.stubGlobal, breaking every test after the first. The
	// per-test stubs (useConvex/useConvexQuery/useAuth) are re-applied in
	// beforeEach, and vitest isolates globals per test file.
});

describe('useThreadPresence', () => {
	it('beats on mount and includes the current viewing mode', async () => {
		mountHost(ref(false));
		await nextTick();

		expect(mutation).toHaveBeenCalled();
		const [, args] = mutation.mock.calls[0]!;
		expect(args).toMatchObject({ mode: 'viewing' });
	});

	it('does not beat while the tab is hidden, then resumes on visibilitychange', async () => {
		setHidden(true);
		mountHost(ref(false));
		await nextTick();

		// Hidden on mount → no heartbeat.
		expect(mutation).not.toHaveBeenCalled();

		// Tab becomes visible again → resume with an immediate beat.
		setHidden(false);
		document.dispatchEvent(new Event('visibilitychange'));
		await nextTick();

		expect(mutation).toHaveBeenCalled();
	});

	it('flips mode to replying when the editor gains focus', async () => {
		const replying = ref(false);
		mountHost(replying);
		await nextTick();
		mutation.mockClear();

		replying.value = true;
		await nextTick();

		expect(mutation).toHaveBeenCalled();
		const lastCall = mutation.mock.calls.at(-1)!;
		expect(lastCall[1]).toMatchObject({ mode: 'replying' });
	});
});
