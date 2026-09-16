// @vitest-environment happy-dom
/**
 * DesktopProvisioningTimeline — the live log pane the "set up a new server"
 * wizard streams the installer into.
 *
 * A quickstart run produces thousands of lines and the composable keeps a deep
 * scrollback, so the pane's contract is about what it does NOT paint:
 *   - only the last `VISIBLE_TAIL_LINES` are rendered; the rest are trimmed,
 *     and the trimmed count is stated instead of silently dropped;
 *   - the trimmed notice stays away while the run fits under the cap;
 *   - the pane follows the tail only while the reader is parked at the bottom —
 *     scrolling up to read a stack trace pauses the follow and offers a way
 *     back, so new output can never yank the view mid-read.
 *
 * happy-dom gives every element a zero layout box, so the suite defines the
 * scroll geometry (`scrollHeight`/`clientHeight`) the pane reads.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';

import ProvisioningTimeline from '../ProvisioningTimeline.vue';
import { createTestI18n, i18nStubs, expectFullyLocalized } from '~/__tests__/i18n';
import { createTimeline } from '~/lib/desktop/provisioning';
import type { LogLine } from '~/composables/useServerProvisioning';

enableAutoUnmount(afterEach);

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const iconStub = { props: ['name'], template: '<i class="icon" :data-name="name" />' };
const progressStub = { props: ['size', 'value'], template: '<div class="progress" />' };

function logs(count: number, prefix = 'line'): LogLine[] {
	return Array.from({ length: count }, (_, i) => ({
		stream: 'stdout' as const,
		line: `${prefix} ${i + 1}`,
	}));
}

function mountTimeline(lines: LogLine[]) {
	return mount(ProvisioningTimeline, {
		props: { steps: createTimeline(), logs: lines, progress: 42 },
		global: {
			plugins: [createTestI18n()],
			components: { Icon: iconStub, UiProgressBar: progressStub },
		},
	});
}

/** Open the drawer and hand back its scroll pane. */
async function openLog(wrapper: ReturnType<typeof mountTimeline>) {
	await wrapper.get('button').trigger('click');
	return wrapper.get('[role="log"]');
}

/** happy-dom has no layout: state the geometry the pane's at-bottom test reads. */
function setGeometry(el: HTMLElement, { scrollHeight = 5000, clientHeight = 256 } = {}): void {
	Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
	Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
}

describe('DesktopProvisioningTimeline log pane', () => {
	it('paints only the tail and states how many earlier lines were trimmed', async () => {
		const wrapper = mountTimeline(logs(1200));
		const pane = await openLog(wrapper);

		const rendered = pane.findAll('p.whitespace-pre-wrap').map((p) => p.text());
		expect(rendered).toHaveLength(500);
		// The newest line is present, the oldest is gone.
		expect(rendered.at(-1)).toBe('line 1200');
		expect(rendered[0]).toBe('line 701');
		expect(pane.text()).toContain('700 earlier lines trimmed');
		expectFullyLocalized(wrapper);
	});

	it('says nothing about trimming while the whole run fits in the pane', async () => {
		const wrapper = mountTimeline(logs(12));
		const pane = await openLog(wrapper);

		expect(pane.findAll('p.whitespace-pre-wrap')).toHaveLength(12);
		expect(pane.text()).not.toContain('trimmed');
	});

	it('keeps the scroll pane scrollable and reachable by keyboard', async () => {
		const wrapper = mountTimeline(logs(1200));
		const pane = await openLog(wrapper);

		expect(pane.classes()).toContain('overflow-y-auto');
		expect(pane.attributes('tabindex')).toBe('0');
		expect(pane.attributes('aria-label')).toBe('Server log output');
	});

	it('follows the tail while parked at the bottom — no "jump to latest" offered', async () => {
		const wrapper = mountTimeline(logs(10));
		const pane = await openLog(wrapper);
		const el = pane.element as HTMLElement;
		setGeometry(el, { scrollHeight: 1000, clientHeight: 256 });
		el.scrollTop = 744;
		await pane.trigger('scroll');

		expect(wrapper.text()).not.toContain('Jump to latest');

		await wrapper.setProps({ logs: logs(11) });
		await wrapper.vm.$nextTick();
		expect(el.scrollTop).toBe(el.scrollHeight);
	});

	it('stops chasing new output once the reader scrolls up, and offers a way back', async () => {
		const wrapper = mountTimeline(logs(10));
		const pane = await openLog(wrapper);
		const el = pane.element as HTMLElement;
		setGeometry(el, { scrollHeight: 1000, clientHeight: 256 });

		// Scrolled up to read something: the view must stay where it was put.
		el.scrollTop = 120;
		await pane.trigger('scroll');
		expect(wrapper.text()).toContain('Jump to latest');

		await wrapper.setProps({ logs: logs(40) });
		await wrapper.vm.$nextTick();
		expect(el.scrollTop).toBe(120);

		// ...and the way back re-pins to the newest output.
		const jump = wrapper.findAll('button').find((b) => b.text().includes('Jump to latest'));
		await jump?.trigger('click');
		await wrapper.vm.$nextTick();
		expect(el.scrollTop).toBe(el.scrollHeight);
		expect(wrapper.text()).not.toContain('Jump to latest');
	});
});
