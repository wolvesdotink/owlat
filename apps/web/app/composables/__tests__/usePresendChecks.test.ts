// @vitest-environment happy-dom
/**
 * The pre-send checks as reactive state (composables/usePresendChecks):
 *   - nothing goes to the server until `run()`;
 *   - a run asks for exactly the probe-ready links and images, the subject,
 *     the HTML and the sender;
 *   - a newer run wins over an older one still in flight, and a failure reads
 *     as "could not run", not as a pass;
 *   - once run, a change to anything the screening reads (the HTML, the
 *     subject, the sender) retires the old answers at once and is checked
 *     again by itself once the input settles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { DEFAULT_EMAIL_THEME } from '@owlat/shared/emailDefaults';
import {
	PRESEND_RECHECK_DELAY_MS,
	usePresendChecks,
	type PresendSource,
} from '../usePresendChecks';

vi.mock('@owlat/api', () => ({
	api: { emailTemplates: { presendChecksActions: { run: 'presend.run' } } },
}));

const action = vi.fn();

const RESULT = {
	links: [{ url: 'https://example.com/a', status: 'ok', httpStatus: 200 }],
	images: [],
	screening: { status: 'unavailable' },
};

beforeEach(() => {
	action.mockReset().mockResolvedValue(RESULT);
	vi.stubGlobal('useConvex', () => ({ action }));
	vi.stubGlobal('useEmailTheme', () => ({ emailTheme: ref(DEFAULT_EMAIL_THEME) }));
});

afterEach(() => {
	vi.useRealTimers();
});

const html = (body: string) => `<html><body>${body}</body></html>`;

function setup(initial: Partial<PresendSource> = {}) {
	const source = ref<PresendSource>({
		html: html(
			'<a href="https://example.com/a">a</a><img src="https://cdn.example/x.png" alt="x">'
		),
		blocks: [],
		subject: 'Hello',
		fromEmail: 'news@example.com',
		...initial,
	});
	const presend = usePresendChecks(() => source.value);
	return { source, presend };
}

const status = (presend: ReturnType<typeof usePresendChecks>, id: string) =>
	presend.checks.value.find((check) => check.id === id)?.status;

describe('usePresendChecks', () => {
	it('asks the server only when run, with the probe-ready URLs and the message', async () => {
		const { presend } = setup();
		await flushPromises();
		expect(action).not.toHaveBeenCalled();
		expect(presend.isChecking.value).toBe(false);

		void presend.run();
		expect(presend.isChecking.value).toBe(true);
		await flushPromises();

		expect(action).toHaveBeenCalledWith('presend.run', {
			links: ['https://example.com/a'],
			images: ['https://cdn.example/x.png'],
			screening: {
				subject: 'Hello',
				html: expect.stringContaining('example.com/a'),
				fromEmail: 'news@example.com',
			},
		});
		expect(presend.isChecking.value).toBe(false);
		expect(status(presend, 'links')).toBe('pass');
		expect(status(presend, 'screening')).toBe('skipped');
	});

	it('lets the newest run win and reads a failure as "could not run"', async () => {
		let resolveFirst: (value: unknown) => void = () => {};
		action
			.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
			.mockRejectedValueOnce(new Error('rate limited'));
		const { presend } = setup();

		void presend.run();
		void presend.run();
		await flushPromises();
		expect(status(presend, 'links')).toBe('skipped');

		resolveFirst(RESULT);
		await flushPromises();
		expect(status(presend, 'links')).toBe('skipped');
	});

	it('still probes an email too long to send for screening, and says why screening did not run', async () => {
		const { presend } = setup({
			html: html(`<a href="https://example.com/a">a</a><p>${'x'.repeat(1024 * 1024)}</p>`),
		});
		void presend.run();
		await flushPromises();

		const [, args] = action.mock.calls[0]!;
		expect(args.screening).toBeUndefined();
		expect(args.links).toEqual(['https://example.com/a']);
		expect(status(presend, 'links')).toBe('pass');
		expect(presend.checks.value.find((check) => check.id === 'screening')?.summary).toBe(
			'components.campaigns.presendChecks.screening.tooLarge'
		);
	});

	it('checks a new version of the email again once it has run', async () => {
		vi.useFakeTimers();
		const { source, presend } = setup();
		void presend.run();
		await flushPromises();
		expect(action).toHaveBeenCalledTimes(1);

		source.value = { ...source.value, html: html('<p>Changed</p>') };
		await nextTick();
		expect(presend.isChecking.value).toBe(true);
		await vi.advanceTimersByTimeAsync(PRESEND_RECHECK_DELAY_MS);
		await flushPromises();
		expect(action).toHaveBeenCalledTimes(2);
	});

	const SPAM = {
		...RESULT,
		screening: {
			status: 'ready',
			verdict: {
				enabled: true,
				verdict: 'reject',
				reason: 'spam_score',
				sizeLimitKb: 10_240,
				spam: { score: 9, threshold: 5 },
			},
		},
	};

	it.each([
		['subject', { subject: 'A calmer subject' }],
		['sender', { fromEmail: 'hello@example.com' }],
	] as const)(
		'retires the screening verdict when only the %s changes, and screens the new one',
		async (_, change) => {
			vi.useFakeTimers();
			action.mockResolvedValueOnce(SPAM).mockResolvedValueOnce(RESULT);
			const { source, presend } = setup();
			void presend.run();
			await flushPromises();
			expect(status(presend, 'screening')).toBe('warning');

			source.value = { ...source.value, ...change };
			await nextTick();
			// The old verdict answered for another message: it is gone at once.
			expect(status(presend, 'screening')).toBe('pending');
			expect(presend.isChecking.value).toBe(true);

			// Every keystroke would be one run; the new input is screened once it settles.
			source.value = { ...source.value, ...change };
			await vi.advanceTimersByTimeAsync(PRESEND_RECHECK_DELAY_MS);
			await flushPromises();
			expect(action).toHaveBeenCalledTimes(2);
			expect(action.mock.calls[1]![1].screening).toMatchObject(change);
			expect(status(presend, 'screening')).toBe('skipped');
		}
	);

	it('drops an answer for inputs that changed while it was in flight', async () => {
		vi.useFakeTimers();
		let resolveFirst: (value: unknown) => void = () => {};
		action.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
		const { source, presend } = setup();
		void presend.run();
		await flushPromises();

		source.value = { ...source.value, subject: 'Changed while screening' };
		await nextTick();
		resolveFirst(SPAM);
		await flushPromises();
		expect(status(presend, 'screening')).toBe('pending');

		await vi.advanceTimersByTimeAsync(PRESEND_RECHECK_DELAY_MS);
		await flushPromises();
		expect(action).toHaveBeenCalledTimes(2);
		expect(status(presend, 'screening')).toBe('skipped');
	});
});
