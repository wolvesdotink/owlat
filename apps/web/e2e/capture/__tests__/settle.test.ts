/**
 * When a page becomes a shot, with the browser checks scripted: the shot is
 * kept only if the page is still loaded and still the requested page after it
 * was taken, so a placeholder or a sign-in redirect that appears once the DOM
 * went quiet never ends up in a PNG.
 */
import { describe, expect, it } from 'vitest';
import { SETTLE_ATTEMPTS, shootWhenSettled, type PageChecks } from '../settle';
import { CaptureFailure } from '../surfaces';

interface Script {
	/** `loaded()` results, in call order; the last one repeats. */
	loaded?: boolean[];
	/** `blocker()` results, in call order; the last one repeats. */
	blocker?: Array<string | null>;
	waitLoaded?: boolean;
	waitQuiet?: boolean;
}

function scripted(script: Script) {
	const calls: string[] = [];
	const next = <T>(values: T[], fallback: T): T =>
		values.length > 1 ? values.shift()! : (values[0] ?? fallback);
	const loaded = [...(script.loaded ?? [true])];
	const blocker = [...(script.blocker ?? [null])];
	let shots = 0;
	const checks: PageChecks = {
		blocker: async () => {
			calls.push('blocker');
			return next(blocker, null);
		},
		loaded: async () => {
			calls.push('loaded');
			return next(loaded, true);
		},
		waitLoaded: async () => {
			calls.push('waitLoaded');
			return script.waitLoaded ?? true;
		},
		waitQuiet: async () => {
			calls.push('waitQuiet');
			return script.waitQuiet ?? true;
		},
		paint: async () => {
			calls.push('paint');
		},
		screenshot: async () => {
			calls.push('screenshot');
			shots += 1;
			return new Uint8Array([shots]);
		},
	};
	return { checks, calls };
}

describe('shootWhenSettled', () => {
	it('shoots once the page is loaded and quiet, and checks it again afterwards', async () => {
		const { checks, calls } = scripted({});
		expect(await shootWhenSettled('contacts', checks)).toEqual(new Uint8Array([1]));
		expect(calls).toEqual([
			'blocker',
			'waitLoaded',
			'waitQuiet',
			'paint',
			'screenshot',
			'blocker',
			'loaded',
		]);
	});

	it('discards a shot taken while a late placeholder showed, and waits again', async () => {
		const { checks, calls } = scripted({ loaded: [false, true] });
		expect(await shootWhenSettled('dashboard', checks)).toEqual(new Uint8Array([2]));
		expect(calls.filter((call) => call === 'waitQuiet')).toHaveLength(2);
	});

	it('reports a placeholder that comes back after every quiet period', async () => {
		const { checks, calls } = scripted({ loaded: [false] });
		await expect(shootWhenSettled('dashboard', checks)).rejects.toThrow(
			/dashboard: a loading placeholder came back/
		);
		expect(calls.filter((call) => call === 'screenshot')).toHaveLength(SETTLE_ATTEMPTS);
	});

	it('refuses a page that left for sign-in or an error page after going quiet', async () => {
		const { checks } = scripted({
			blocker: [null, 'the app sent the browser back to sign-in (/auth/login).'],
		});
		await expect(shootWhenSettled('postbox', checks)).rejects.toThrow(
			new CaptureFailure('postbox: the app sent the browser back to sign-in (/auth/login).')
		);
	});

	it('refuses a blocked page before waiting for anything', async () => {
		const { checks, calls } = scripted({ blocker: ['the app rendered its error page (404).'] });
		await expect(shootWhenSettled('path-x', checks)).rejects.toThrow(/error page \(404\)/);
		expect(calls).toEqual(['blocker']);
	});

	it('reports a page that never finished loading or never stopped changing', async () => {
		await expect(
			shootWhenSettled('contact', scripted({ waitLoaded: false }).checks)
		).rejects.toThrow(/contact: the page was still loading/);
		const restless = scripted({ waitQuiet: false });
		await expect(shootWhenSettled('contact', restless.checks)).rejects.toThrow(
			/contact: the page kept changing/
		);
		expect(restless.calls).not.toContain('screenshot');
	});
});
