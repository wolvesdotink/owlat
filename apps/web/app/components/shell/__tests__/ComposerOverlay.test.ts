// @vitest-environment happy-dom
/**
 * The shell's composer host: Compose opens over the current page, so the shell
 * mounts the floating composer stack — except where the page already mounts its
 * own, which would draw every composer twice.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ComposerOverlay from '../ComposerOverlay.vue';

let path = '/dashboard';

beforeEach(() => {
	Object.assign(globalThis, { useRoute: () => ({ path }) });
});

function mountOverlay() {
	return mount(ComposerOverlay, {
		global: { stubs: { PostboxComposerStack: { template: '<div data-testid="stack" />' } } },
	});
}

describe('ShellComposerOverlay', () => {
	it('hosts the composer stack on pages without one', () => {
		path = '/dashboard/audience/contacts/c_1';
		expect(mountOverlay().find('[data-testid="stack"]').exists()).toBe(true);
	});

	it('stays out of the way where the page hosts its own stack', () => {
		path = '/dashboard/postbox/inbox';
		expect(mountOverlay().find('[data-testid="stack"]').exists()).toBe(false);
		path = '/dashboard/answer';
		expect(mountOverlay().find('[data-testid="stack"]').exists()).toBe(false);
	});
});
