import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref } from 'vue';

// `useSidebarState` calls the auto-imported `useLocalStorage` at module scope,
// so it must be stubbed before the module is imported. A simple ref-backed
// store is enough for the state-machine transitions under test.
vi.stubGlobal('useLocalStorage', <T>(_key: string, defaultValue: T) => {
	const data = ref<T>(defaultValue);
	return {
		data,
		set: (value: T) => {
			data.value = value;
		},
	};
});

const { useSidebarState } = await import('../useSidebarState');

describe('useSidebarState', () => {
	beforeEach(() => {
		// Reset the module-level singleton to a known desktop-visible baseline.
		const s = useSidebarState();
		s.setDesktopViewport(true);
		s.setHidden(false);
		s.setCollapsed(false);
		s.closePeek();
	});

	describe('mode transitions', () => {
		it('defaults to visible', () => {
			const s = useSidebarState();
			expect(s.sidebarMode.value).toBe('visible');
			expect(s.effectiveHidden.value).toBe(false);
			expect(s.isPeeking.value).toBe(false);
		});

		it('collapse toggles between visible and collapsed', () => {
			const s = useSidebarState();
			s.toggleCollapsed();
			expect(s.sidebarMode.value).toBe('collapsed');
			s.toggleCollapsed();
			expect(s.sidebarMode.value).toBe('visible');
		});

		it('hide toggles into hidden mode', () => {
			const s = useSidebarState();
			s.toggleHidden();
			expect(s.isHidden.value).toBe(true);
			expect(s.effectiveHidden.value).toBe(true);
			expect(s.sidebarMode.value).toBe('hidden');
			s.toggleHidden();
			expect(s.sidebarMode.value).toBe('visible');
		});

		it('hidden is orthogonal to collapsed', () => {
			const s = useSidebarState();
			s.setCollapsed(true);
			s.setHidden(true);
			// Hidden wins for the resolved mode...
			expect(s.sidebarMode.value).toBe('hidden');
			// ...but un-hiding restores the collapsed rail, not the full one.
			s.setHidden(false);
			expect(s.sidebarMode.value).toBe('collapsed');
		});
	});

	describe('breakpoint guard', () => {
		it('toggleHidden is a no-op below the desktop breakpoint', () => {
			const s = useSidebarState();
			s.setDesktopViewport(false);
			s.toggleHidden();
			expect(s.isHidden.value).toBe(false);
			expect(s.sidebarMode.value).toBe('visible');
		});

		it('a persisted hidden value does not apply on a mobile viewport', () => {
			const s = useSidebarState();
			s.setHidden(true);
			expect(s.effectiveHidden.value).toBe(true);
			s.setDesktopViewport(false);
			// Raw persisted value stays true, but it no longer takes effect.
			expect(s.isHidden.value).toBe(true);
			expect(s.effectiveHidden.value).toBe(false);
			expect(s.sidebarMode.value).toBe('visible');
		});
	});

	describe('peek overlay', () => {
		it('opens only while hidden', () => {
			const s = useSidebarState();
			s.openPeek();
			expect(s.isPeeking.value).toBe(false); // visible → no peek
			s.setHidden(true);
			s.openPeek();
			expect(s.isPeeking.value).toBe(true);
		});

		it('closePeek (Esc / focus loss) dismisses it', () => {
			const s = useSidebarState();
			s.setHidden(true);
			s.openPeek();
			expect(s.isPeeking.value).toBe(true);
			s.closePeek();
			expect(s.isPeeking.value).toBe(false);
		});

		it('toggling hidden clears any active peek', () => {
			const s = useSidebarState();
			s.setHidden(true);
			s.openPeek();
			s.toggleHidden(); // un-hide
			expect(s.effectiveHidden.value).toBe(false);
			expect(s.isPeeking.value).toBe(false);
		});

		it('leaving the desktop breakpoint closes the peek', () => {
			const s = useSidebarState();
			s.setHidden(true);
			s.openPeek();
			expect(s.isPeeking.value).toBe(true);
			s.setDesktopViewport(false);
			expect(s.isPeeking.value).toBe(false);
		});
	});
});
