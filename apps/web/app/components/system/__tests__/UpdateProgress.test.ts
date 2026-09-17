// @vitest-environment happy-dom
/**
 * The in-flight update log (Settings → System & Updates → Update now).
 *
 * It used to read a step's outcome off its `stderr`: non-empty meant failure.
 * Docker writes pull and recreate PROGRESS to stderr on SUCCESS, so a healthy
 * update painted "Pull new container images" and "Recreate containers" red and
 * offered ` web Pulled` as the error message — the operator watched a working
 * update tell them it had failed twice. The updater sidecar reports a real
 * per-step verdict (`ok`, i.e. the docker command exited zero) and that is what
 * the list reads now, falling back to the old reading only for the steps that
 * carry no verdict.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import UpdateProgress from '../UpdateProgress.vue';

// `useI18n` and `$fetch` are Nuxt auto-imports; the component reaches for both
// during setup/mount (the second to poll updater health).
beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		$fetch: vi.fn().mockRejectedValue(new Error('updater unreachable')),
	});
});

type Step = { step: string; ok?: boolean; stdout?: string; stderr?: string };

/** Exactly what the sidecar returns for a fully successful update. */
const SUCCESSFUL_UPDATE: Step[] = [
	{ step: 'stage-compose', stdout: 'New compose template staged', stderr: '' },
	{ step: 'pull', ok: true, stdout: '', stderr: ' web Pulling\n web Pulled\n' },
	{ step: 'convex-deploy', ok: true, stdout: 'Deployed Convex functions', stderr: '' },
	{ step: 'write-compose', stdout: 'Compose file updated', stderr: '' },
	{ step: 'pin-version', ok: true, stdout: 'OWLAT_VERSION pinned to 0.4.17', stderr: '' },
	{ step: 'up', ok: true, stdout: '', stderr: ' Container owlat-web-1  Started\n' },
];

function mountLog(steps: Step[]) {
	return mount(UpdateProgress, {
		props: { targetVersion: '0.4.17', steps },
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

/** The icon name the row for `step` is painted with. */
function iconFor(wrapper: ReturnType<typeof mountLog>, label: string): string | undefined {
	const row = wrapper.findAll('li').find((li) => li.text().includes(label));
	return row?.find('icon-stub').attributes('name');
}

/** The error line under a step, if the row shows one. (`p`, because the row's
 * icon carries `text-error` too when the step failed.) */
function errorTextFor(wrapper: ReturnType<typeof mountLog>, label: string): string {
	const row = wrapper.findAll('li').find((li) => li.text().includes(label));
	return row?.find('p.text-error').text() ?? '';
}

const SUCCESS = 'lucide:check-circle-2';
const FAILED = 'lucide:x-circle';
const PENDING = 'lucide:circle';

afterEach(() => {
	vi.clearAllTimers();
});

describe('UpdateProgress — step outcomes', () => {
	it('paints every step of a successful update as done, docker progress and all', () => {
		const wrapper = mountLog(SUCCESSFUL_UPDATE);

		expect(iconFor(wrapper, 'Pull new container images')).toBe(SUCCESS);
		expect(iconFor(wrapper, 'Recreate containers with new versions')).toBe(SUCCESS);
		expect(iconFor(wrapper, 'Deploy backend functions')).toBe(SUCCESS);
		expect(iconFor(wrapper, 'Write pinned compose template')).toBe(SUCCESS);
		// Nothing on stderr is presented as an error.
		expect(wrapper.find('p.text-error').exists()).toBe(false);
		wrapper.unmount();
	});

	it('still paints a step the sidecar reports as failed, with its error', () => {
		const wrapper = mountLog([
			{ step: 'stage-compose', stdout: 'New compose template staged', stderr: '' },
			{
				step: 'pull',
				ok: false,
				stdout: '',
				stderr: 'Error response from daemon: manifest unknown',
			},
		]);

		expect(iconFor(wrapper, 'Pull new container images')).toBe(FAILED);
		expect(errorTextFor(wrapper, 'Pull new container images')).toContain('manifest unknown');
		// The steps the updater never reached stay pending rather than claiming a verdict.
		expect(iconFor(wrapper, 'Recreate containers with new versions')).toBe(PENDING);
		wrapper.unmount();
	});

	it('falls back to reading stderr for a step that carries no verdict', () => {
		const wrapper = mountLog([
			{ step: 'write-compose', stdout: '', stderr: 'Failed to promote compose file' },
		]);

		expect(iconFor(wrapper, 'Write pinned compose template')).toBe(FAILED);
		wrapper.unmount();
	});

	it('treats a warning-only stderr on a verdictless step as done', () => {
		const wrapper = mountLog([
			{ step: 'write-compose', stdout: '', stderr: 'Warning: orphan container removed' },
		]);

		expect(iconFor(wrapper, 'Write pinned compose template')).toBe(SUCCESS);
		wrapper.unmount();
	});
});
