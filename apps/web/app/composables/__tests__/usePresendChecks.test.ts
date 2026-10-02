// @vitest-environment happy-dom
/**
 * The pre-send checks as reactive state (composables/usePresendChecks):
 *   - nothing goes to the server until `run()`;
 *   - a run asks for exactly the probe-ready links and images, the subject,
 *     the HTML and the sender;
 *   - a newer run wins over an older one still in flight, and a failure reads
 *     as "could not run", not as a pass;
 *   - once run, a new version of the HTML is checked again by itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { DEFAULT_EMAIL_THEME } from '@owlat/shared/emailDefaults';
import { usePresendChecks, type PresendSource } from '../usePresendChecks';

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
		const { source, presend } = setup();
		void presend.run();
		await flushPromises();
		expect(action).toHaveBeenCalledTimes(1);

		source.value = { ...source.value, html: html('<p>Changed</p>') };
		await nextTick();
		await flushPromises();
		expect(action).toHaveBeenCalledTimes(2);
	});
});
