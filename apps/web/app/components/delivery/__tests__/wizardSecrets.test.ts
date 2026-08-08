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
import { buttonByText, fillCredentials, mountWizard, openWizard } from './wizardHarness';

const SECRET = 're_live_9f3c2b7a41';

/** The ONLY two endpoints a credential is ever allowed to reach. */
const SEALED_ENDPOINTS = ['/api/delivery/validate-transport', '/api/delivery/apply-transport'];

let fetchMock: ReturnType<typeof vi.fn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	fetchMock = vi.fn(async (url: string) =>
		url === '/api/delivery/validate-transport'
			? { ok: true, message: 'Credentials verified.' }
			: { ok: true, message: 'Applied.', applied: true, requiresRestart: false }
	);
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
	await fillCredentials(wrapper, 'resend', SECRET);
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
	it('sends the credential only to the two shipped sealed endpoints', async () => {
		const wrapper = await enterAndApply();
		// The shipped live handshake, then the sealed env patch — and nothing else.
		expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(SEALED_ENDPOINTS);
		const applyCall = fetchMock.mock.calls[1] as [string, { body: { providerEnv: unknown } }];
		const providerEnv = applyCall[1].body.providerEnv as Record<string, string>;
		expect(providerEnv['EMAIL_PROVIDER']).toBe('resend');
		expect(providerEnv['RESEND_API_KEY']).toBe(SECRET);
		wrapper.unmount();
	});

	it('never lets the credential reach a URL, a query string or any other endpoint', async () => {
		const wrapper = await enterAndApply();
		for (const [url] of fetchMock.mock.calls as [string, unknown][]) {
			expect(SEALED_ENDPOINTS).toContain(url);
			expect(url).not.toContain(SECRET);
		}
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
		fetchMock.mockImplementation(async (url: string) =>
			url === '/api/delivery/validate-transport'
				? { ok: true, message: 'Credentials verified.' }
				: {
						ok: false,
						message: `Resend rejected API key ${SECRET}`,
						applied: false,
						requiresRestart: false,
					}
		);
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

	it('redacts the live handshake message too, and the restart notice', async () => {
		fetchMock.mockImplementation(async (url: string) =>
			url === '/api/delivery/validate-transport'
				? { ok: false, message: `Resend says: ${SECRET} is not a key` }
				: { ok: true, message: 'Applied.', applied: true, requiresRestart: false }
		);
		const wrapper = await enterAndApply();
		expect(wrapper.text()).not.toContain(SECRET);
		expect(wrapper.text()).toContain(REDACTED_PLACEHOLDER);
		wrapper.unmount();

		fetchMock.mockImplementation(async (url: string) =>
			url === '/api/delivery/validate-transport'
				? { ok: true, message: 'Credentials verified.' }
				: {
						ok: true,
						message: `Restart to pick up ${SECRET}`,
						applied: true,
						requiresRestart: true,
					}
		);
		const restarted = await enterAndApply();
		expect(restarted.text()).not.toContain(SECRET);
		expect(restarted.text()).toContain(REDACTED_PLACEHOLDER);
		restarted.unmount();
	});

	it('exercises the SES and SMTP branches through the same sealed path', async () => {
		for (const kind of ['ses', 'smtp'] as const) {
			fetchMock.mockClear();
			const wrapper = mountWizard();
			await openWizard(wrapper);
			await fillCredentials(wrapper, kind, SECRET);
			await buttonByText(wrapper, 'Save credentials').trigger('click');
			await flushPromises();
			for (const [url] of fetchMock.mock.calls as [string, unknown][]) {
				expect(SEALED_ENDPOINTS).toContain(url);
			}
			expect(wrapper.html()).not.toContain(SECRET);
			wrapper.unmount();
		}
	});
});
