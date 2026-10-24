import { describe, expect, it } from 'vitest';
import { isContainedRenderError } from '../renderPhaseError';

/**
 * A pane boundary shows its fallback only for failures that leave the pane
 * unable to render. Vue names the phase as a readable string in development
 * and as an error-reference URL in production; both must classify the same.
 */
const prodInfo = (code: string) => `https://vuejs.org/error-reference/#runtime-${code}`;

describe('isContainedRenderError', () => {
	it.each([
		['setup function', '0'],
		['render function', '1'],
		['async component loader', '13'],
		['scheduler flush', '14'],
		['component update', '15'],
	])('contains %s (production code %s)', (devInfo, code) => {
		const error = new Error('boom');
		expect(isContainedRenderError(error, devInfo)).toBe(true);
		expect(isContainedRenderError(error, prodInfo(code))).toBe(true);
	});

	it.each([
		['native event handler', '5'],
		['component event handler', '6'],
		['watcher callback', '3'],
		['watcher getter', '2'],
		['directive hook', '8'],
		['mounted hook', 'm'],
		['unmounted hook', 'um'],
	])('lets %s through to the app handler (production code %s)', (devInfo, code) => {
		const error = new Error('boom');
		expect(isContainedRenderError(error, devInfo)).toBe(false);
		expect(isContainedRenderError(error, prodInfo(code))).toBe(false);
	});

	it('lets a fatal or unhandled Nuxt error reach the full-page error screen', () => {
		const nuxtError = (flags: Record<string, boolean>) =>
			Object.assign(new Error('gone'), { __nuxt_error: true, ...flags });
		expect(isContainedRenderError(nuxtError({ fatal: true }), 'setup function')).toBe(false);
		expect(isContainedRenderError(nuxtError({ unhandled: true }), 'render function')).toBe(false);
		expect(isContainedRenderError(nuxtError({}), 'render function')).toBe(true);
	});

	it('contains a thrown non-error value', () => {
		expect(isContainedRenderError('a string', 'render function')).toBe(true);
		expect(isContainedRenderError(null, 'render function')).toBe(true);
	});

	it('does not mistake an unknown info string for a render phase', () => {
		expect(isContainedRenderError(new Error('x'), '')).toBe(false);
		expect(isContainedRenderError(new Error('x'), 'render function (custom)')).toBe(false);
		expect(isContainedRenderError(new Error('x'), prodInfo('99'))).toBe(false);
	});
});
