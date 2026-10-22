// @vitest-environment happy-dom
/**
 * The connection dot in the sidebar footer and the desktop titlebar: nothing
 * while connected, a labelled dot once a drop outlasts the grace period, and
 * every element a Tauri drag region inside the titlebar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import {
	attachBackendConnection,
	CONNECTION_GRACE_MS,
	reportRolloutActivity,
	resetBackendConnection,
} from '~/lib/backendConnection';
import ConnectionIndicator from '../ConnectionIndicator.vue';

let setConnected: (connected: boolean) => void;

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	let state = { isWebSocketConnected: true, hasEverConnected: true };
	const listeners = new Set<(s: typeof state) => void>();
	attachBackendConnection({
		connectionState: () => state,
		subscribeToConnectionState: (cb) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
	});
	setConnected = (connected) => {
		state = { ...state, isWebSocketConnected: connected };
		for (const cb of listeners) cb(state);
	};
});
enableAutoUnmount(afterEach);
afterEach(() => {
	resetBackendConnection();
	vi.useRealTimers();
});

function render(props: { compact?: boolean; dragRegion?: boolean } = {}) {
	return mount(ConnectionIndicator, { props, global: { plugins: [createTestI18n()] } });
}

async function dropFor(ms: number) {
	setConnected(false);
	vi.advanceTimersByTime(ms);
	await nextTick();
}

describe('ConnectionIndicator', () => {
	it('renders nothing while connected or during a short drop', async () => {
		const wrapper = render();
		expect(wrapper.find('[data-testid="connection-indicator"]').exists()).toBe(false);

		await dropFor(CONNECTION_GRACE_MS - 1);
		expect(wrapper.find('[data-testid="connection-indicator"]').exists()).toBe(false);
	});

	it('shows the label and explains it on hover after a sustained drop', async () => {
		const wrapper = render();
		await dropFor(CONNECTION_GRACE_MS);

		const indicator = wrapper.get('[data-testid="connection-indicator"]');
		expect(indicator.attributes('data-phase')).toBe('reconnecting');
		expect(indicator.text()).toBe('Reconnecting…');
		expect(indicator.attributes('title')).toMatch(/connection to the server dropped/i);

		setConnected(true);
		await nextTick();
		expect(wrapper.find('[data-testid="connection-indicator"]').exists()).toBe(false);
	});

	it('keeps the label for screen readers on the collapsed rail', async () => {
		const wrapper = render({ compact: true });
		await dropFor(CONNECTION_GRACE_MS);

		const label = wrapper.get('[data-testid="connection-indicator"] .sr-only');
		expect(label.text()).toBe('Reconnecting…');
	});

	it('says an update is in progress when the drop comes during one', async () => {
		reportRolloutActivity(Date.now());
		const wrapper = render();
		await dropFor(CONNECTION_GRACE_MS);

		expect(wrapper.get('[data-testid="connection-indicator"]').text()).toBe('Update in progress');
	});

	it('marks every element a drag region inside the titlebar, and none elsewhere', async () => {
		const inTitlebar = render({ dragRegion: true });
		const inFooter = render();
		await dropFor(CONNECTION_GRACE_MS);

		const titlebarEls = inTitlebar.findAll('*');
		expect(titlebarEls.length).toBeGreaterThan(1);
		for (const el of titlebarEls) {
			expect(el.attributes('data-tauri-drag-region')).toBeDefined();
		}
		expect(inTitlebar.attributes('data-tauri-drag-region')).toBeDefined();
		expect(inFooter.html()).not.toContain('data-tauri-drag-region');
	});
});
