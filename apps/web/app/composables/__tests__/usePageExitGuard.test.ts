/**
 * The one way a page warns before it is left: the browser's prompt on close
 * and the app update's reload gate answer from the same dirty flag, so an
 * update reload never starts only to stop at a prompt with the page still
 * open.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { withSetup } from '~/__tests__/withSetup';
import { hasReloadBlocker } from '~/lib/reloadBlockers';
import { usePageExitGuard } from '../usePageExitGuard';

const mounts: Array<() => void> = [];
afterEach(() => {
	for (const unmount of mounts.splice(0)) unmount();
});

function beforeUnloadPrevented(): boolean {
	const event = new Event('beforeunload', { cancelable: true });
	window.dispatchEvent(event);
	return event.defaultPrevented;
}

describe('usePageExitGuard', () => {
	it('warns on close and blocks an update reload exactly while dirty and mounted', () => {
		let dirty = false;
		const page = withSetup(() => usePageExitGuard(() => dirty));
		mounts.push(page.unmount);
		expect(beforeUnloadPrevented()).toBe(false);
		expect(hasReloadBlocker()).toBe(false);

		dirty = true;
		expect(beforeUnloadPrevented()).toBe(true);
		expect(hasReloadBlocker()).toBe(true);

		page.unmount();
		mounts.length = 0;
		expect(beforeUnloadPrevented()).toBe(false);
		expect(hasReloadBlocker()).toBe(false);
	});
});

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
		return /\.(ts|vue)$/.test(name) ? [path] : [];
	});
}

describe('beforeunload warnings', () => {
	it('all go through usePageExitGuard, so the update reload gate hears every one', () => {
		const own = join(appRoot, 'composables/usePageExitGuard.ts');
		const offenders = sources(appRoot)
			.filter(
				(file) =>
					file !== own && /['"`]beforeunload['"`]|onbeforeunload/.test(readFileSync(file, 'utf8'))
			)
			.map((file) => relative(appRoot, file));
		expect(offenders).toEqual([]);
	});

	it('covers the setup wizard, whose draft the browser warns about on close', () => {
		const wizard = readFileSync(join(appRoot, 'composables/useSetupWizard.ts'), 'utf8');
		expect(wizard).toMatch(/usePageExitGuard\(\(\) => !completed\.value && hasDraftData\(\)\)/);
	});
});
