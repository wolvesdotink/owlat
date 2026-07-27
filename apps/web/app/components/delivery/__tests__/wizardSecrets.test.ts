// @vitest-environment happy-dom
/**
 * Credentials go through the SEALED path and never come back out (P2-4, D4).
 *
 * Three properties, each with a way it could plausibly break:
 *   - the only place a credential is sent is the shipped
 *     `/api/delivery/apply-transport` env patch — no second credential model;
 *   - once applied, the value is dropped from memory, so it cannot be re-read
 *     from the DOM or re-submitted by a later step;
 *   - a provider error that QUOTES the rejected key back at us is redacted
 *     before it reaches the screen, a toast, or the console. That is the one
 *     realistic path by which a secret leaks into a log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { REDACTED_PLACEHOLDER, redactSecrets } from '~/utils/transportWizard';
import { buttonByText, mountWizard, openWizard } from './wizardHarness';

const SECRET = 're_live_9f3c2b7a41';

let fetchMock: ReturnType<typeof vi.fn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	fetchMock = vi.fn(async () => ({
		ok: true,
		message: 'Applied.',
		applied: true,
		requiresRestart: false,
	}));
	vi.stubGlobal('$fetch', fetchMock);
	consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	consoleErrorSpy.mockRestore();
	vi.unstubAllGlobals();
});

async function enterAndApply() {
	const wrapper = mountWizard();
	await openWizard(wrapper);
	await wrapper.find('#field-resend-api-key').setValue(SECRET);
	await buttonByText(wrapper, 'Save credentials').trigger('click');
	await flushPromises();
	return wrapper;
}

describe('redactSecrets', () => {
	it('replaces every occurrence of an entered credential', () => {
		expect(redactSecrets(`rejected key ${SECRET} (${SECRET})`, [SECRET])).toBe(
			`rejected key ${REDACTED_PLACEHOLDER} (${REDACTED_PLACEHOLDER})`
		);
	});

	it('redacts the longest secret first so a nested value is not half-replaced', () => {
		const outer = 'abcd1234';
		const inner = 'cd12';
		expect(redactSecrets(`x ${outer} y`, [inner, outer])).toBe(`x ${REDACTED_PLACEHOLDER} y`);
	});

	it('ignores blank and trivially short values rather than shredding the message', () => {
		expect(redactSecrets('port 587 refused', ['', '  ', 'a'])).toBe('port 587 refused');
	});
});

describe('wizard credentials — the sealed path', () => {
	it('sends the credential only to the shipped apply-transport endpoint', async () => {
		const wrapper = await enterAndApply();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, options] = fetchMock.mock.calls[0] as [string, { body: { providerEnv: unknown } }];
		expect(url).toBe('/api/delivery/apply-transport');
		const providerEnv = options.body.providerEnv as Record<string, string>;
		expect(providerEnv['EMAIL_PROVIDER']).toBe('resend');
		expect(providerEnv['RESEND_API_KEY']).toBe(SECRET);
		wrapper.unmount();
	});

	it('drops the value from memory and from the DOM once applied', async () => {
		const wrapper = await enterAndApply();
		expect(wrapper.html()).not.toContain(SECRET);
		expect((wrapper.find('#field-resend-api-key').element as HTMLInputElement).value).toBe('');
		// The parent is told only THAT a transport was applied.
		expect(wrapper.emitted('applied')).toEqual([[]]);
		wrapper.unmount();
	});

	it('redacts a provider error that quotes the key back', async () => {
		fetchMock.mockImplementation(async () => ({
			ok: false,
			message: `Resend rejected API key ${SECRET}`,
			applied: false,
			requiresRestart: false,
		}));
		const wrapper = await enterAndApply();
		expect(wrapper.text()).toContain('Resend rejected API key');
		expect(wrapper.text()).not.toContain(SECRET);
		expect(wrapper.text()).toContain(REDACTED_PLACEHOLDER);
		wrapper.unmount();
	});

	it('redacts a thrown transport error too, and logs nothing containing the key', async () => {
		fetchMock.mockImplementation(async () => {
			throw new Error(`POST failed for body {"RESEND_API_KEY":"${SECRET}"}`);
		});
		const wrapper = await enterAndApply();
		expect(wrapper.text()).not.toContain(SECRET);
		expect(wrapper.text()).toContain(REDACTED_PLACEHOLDER);
		const logged = consoleErrorSpy.mock.calls.flat().join(' ');
		expect(logged).not.toContain(SECRET);
		wrapper.unmount();
	});
});
