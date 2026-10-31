import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The transport picker, driven through mocked clack prompts.
 *
 * Every prompt records what the wizard PASSED (message, placeholder, initial
 * value, validate) and answers from a table keyed by its message, so a test pins
 * the terminal transcript and the env patch the picker returns. The prompts are
 * built from the catalog's credential fields, so these transcripts are what keep
 * the shipped wording and the written env keys from drifting while the code that
 * produces them names no provider.
 *
 * Empty values must be refused AT THE PROMPT. A bare Enter is the reachable
 * path: `password()` resolves `''`, the wizard probes the provider with an
 * empty bearer token, and — for Emailit, whose validator redacts by splitting
 * the failure text on the key — the operator was handed `f[redacted]e[redacted]t…`
 * instead of a failure they could act on. Clack's `validate` never resolves the
 * prompt on a rejected value, so this is what keeps `''` out of the validator
 * (and out of `.env`) entirely.
 */

type Validate = (value: string | undefined) => string | Error | undefined;

interface PromptCall {
	prompt: 'select' | 'text' | 'password' | 'confirm';
	message: string;
	placeholder?: string;
	initialValue?: unknown;
	options?: { value: string; label?: string; hint?: string }[];
	validate?: Validate;
}

const driver = vi.hoisted(() => ({
	calls: [] as PromptCall[],
	answers: {} as Record<string, unknown>,
	cancelAt: undefined as string | undefined,
}));

const CANCEL = Symbol('cancel');

vi.mock('@clack/prompts', () => {
	const prompt =
		(kind: PromptCall['prompt']) =>
		async (options: Omit<PromptCall, 'prompt'>): Promise<unknown> => {
			driver.calls.push({ prompt: kind, ...options });
			if (driver.cancelAt === options.message) return CANCEL;
			if (!(options.message in driver.answers)) {
				throw new Error(`unexpected prompt: ${options.message}`);
			}
			return driver.answers[options.message];
		};
	return {
		select: prompt('select'),
		password: prompt('password'),
		text: prompt('text'),
		confirm: prompt('confirm'),
		isCancel: (value: unknown) => value === CANCEL,
	};
});

const probes = vi.hoisted(() => ({
	spinner: vi.fn(async (_label: string, run: () => Promise<{ ok: boolean }>) => (await run()).ok),
	validateResendKey: vi.fn(async () => ({ ok: true, message: 'ok' })),
	validateEmailitKey: vi.fn(async () => ({ ok: true, message: 'ok' })),
	validateSmtpRelay: vi.fn(async () => ({ ok: true, message: 'ok' })),
}));

vi.mock('../../lib/progress', () => ({ validateWithSpinner: probes.spinner }));
vi.mock('../../lib/validators', () => ({
	validateResendKey: probes.validateResendKey,
	validateEmailitKey: probes.validateEmailitKey,
	validateSmtpRelay: probes.validateSmtpRelay,
}));

import { pickSendingProvider } from '../setupSendingProvider';

const PICK = 'Email sending provider';

/** The transcript without the validate functions, which are asserted separately. */
function transcript() {
	return driver.calls.map(({ validate: _validate, ...call }) => call);
}

function callFor(message: string): PromptCall {
	const call = driver.calls.find((c) => c.message === message);
	if (!call) throw new Error(`no prompt "${message}"`);
	return call;
}

beforeEach(() => {
	vi.clearAllMocks();
	driver.calls = [];
	driver.answers = {};
	driver.cancelAt = undefined;
});

describe('pickSendingProvider — the picker', () => {
	it('offers every kind a setup config can carry, worded as shipped', async () => {
		driver.answers = { [PICK]: 'mta' };
		await pickSendingProvider();
		expect(callFor(PICK).options).toEqual([
			{ value: 'mta', label: 'Run your own MTA (self-hosted)', hint: 'no third-party' },
			{ value: 'ses', label: 'Amazon SES', hint: 'managed, needs an AWS account' },
			{ value: 'resend', label: 'Resend', hint: 'managed API' },
			{
				value: 'smtp',
				label: 'SMTP relay',
				hint: 'Mailgun / Postmark / SendGrid / Brevo / custom',
			},
			{ value: 'emailit', label: 'Emailit', hint: 'managed API' },
		]);
	});

	it('returns null when the picker itself is cancelled', async () => {
		driver.cancelAt = PICK;
		await expect(pickSendingProvider()).resolves.toBeNull();
	});
});

describe('pickSendingProvider — per-kind transcripts', () => {
	it('mta: asks nothing more and writes only the provider', async () => {
		driver.answers = { [PICK]: 'mta' };
		await expect(pickSendingProvider()).resolves.toEqual({ EMAIL_PROVIDER: 'mta' });
		expect(transcript()).toHaveLength(1);
		expect(probes.spinner).not.toHaveBeenCalled();
	});

	it('resend: one API key, probed with the Resend validator', async () => {
		driver.answers = { [PICK]: 'resend', 'Resend API key (re_...)': 're_live' };
		await expect(pickSendingProvider()).resolves.toEqual({
			EMAIL_PROVIDER: 'resend',
			RESEND_API_KEY: 're_live',
		});
		expect(transcript().slice(1)).toEqual([
			{ prompt: 'password', message: 'Resend API key (re_...)' },
		]);
		expect(probes.spinner).toHaveBeenCalledWith('Validating Resend key', expect.any(Function));
		expect(probes.validateResendKey).toHaveBeenCalledWith('re_live');
	});

	it('emailit: one API key, probed with the Emailit validator', async () => {
		driver.answers = { [PICK]: 'emailit', 'Emailit API key': 'em_live_key' };
		await expect(pickSendingProvider()).resolves.toEqual({
			EMAIL_PROVIDER: 'emailit',
			EMAILIT_API_KEY: 'em_live_key',
		});
		expect(transcript().slice(1)).toEqual([{ prompt: 'password', message: 'Emailit API key' }]);
		expect(probes.spinner).toHaveBeenCalledWith('Validating Emailit key', expect.any(Function));
		expect(probes.validateEmailitKey).toHaveBeenCalledWith('em_live_key');
	});

	it('ses: region, key id and secret, with no pre-apply probe', async () => {
		driver.answers = {
			[PICK]: 'ses',
			'AWS SES region': ' eu-west-1 ',
			AWS_ACCESS_KEY_ID: 'AKIA',
			AWS_SECRET_ACCESS_KEY: ' secret ',
		};
		await expect(pickSendingProvider()).resolves.toEqual({
			EMAIL_PROVIDER: 'ses',
			AWS_SES_REGION: 'eu-west-1',
			AWS_SES_ACCESS_KEY_ID: 'AKIA',
			// A secret is written verbatim; identifiers are trimmed.
			AWS_SES_SECRET_ACCESS_KEY: ' secret ',
		});
		expect(transcript().slice(1)).toEqual([
			{ prompt: 'text', message: 'AWS SES region', placeholder: 'us-east-1' },
			{ prompt: 'text', message: 'AWS_ACCESS_KEY_ID', placeholder: undefined },
			{ prompt: 'password', message: 'AWS_SECRET_ACCESS_KEY' },
		]);
		expect(probes.spinner).not.toHaveBeenCalled();
	});

	it('smtp: preset, endpoint and login, probed with the port that is written', async () => {
		driver.answers = {
			[PICK]: 'smtp',
			'SMTP relay provider': 'postmark',
			'SMTP host': 'smtp.postmarkapp.com',
			'SMTP port': '2525',
			'Use implicit TLS (port 465)? No = STARTTLS on 587': false,
			'SMTP username': 'user',
			'SMTP password': 'pass',
		};
		await expect(pickSendingProvider()).resolves.toEqual({
			EMAIL_PROVIDER: 'smtp',
			SMTP_RELAY_HOST: 'smtp.postmarkapp.com',
			SMTP_RELAY_PORT: '2525',
			SMTP_RELAY_USERNAME: 'user',
			SMTP_RELAY_PASSWORD: 'pass',
			SMTP_RELAY_SECURE: 'false',
		});
		expect(transcript().slice(1)).toEqual([
			{
				prompt: 'select',
				message: 'SMTP relay provider',
				options: [
					{ label: 'Mailgun', value: 'mailgun' },
					{ label: 'Postmark', value: 'postmark' },
					{ label: 'SendGrid', value: 'sendgrid' },
					{ label: 'Brevo', value: 'brevo' },
					{ label: 'Custom SMTP server', value: 'custom' },
				],
			},
			{
				prompt: 'text',
				message: 'SMTP host',
				placeholder: 'smtp.postmarkapp.com',
				initialValue: 'smtp.postmarkapp.com',
			},
			{ prompt: 'text', message: 'SMTP port', placeholder: '587', initialValue: '587' },
			{
				prompt: 'confirm',
				message: 'Use implicit TLS (port 465)? No = STARTTLS on 587',
				initialValue: false,
			},
			{ prompt: 'text', message: 'SMTP username', placeholder: undefined },
			{ prompt: 'password', message: 'SMTP password' },
		]);
		expect(probes.spinner).toHaveBeenCalledWith('Validating SMTP relay', expect.any(Function));
		expect(probes.validateSmtpRelay).toHaveBeenCalledWith({
			host: 'smtp.postmarkapp.com',
			port: 2525,
			secure: false,
			username: 'user',
			password: 'pass',
		});
	});

	it('smtp: a custom relay shows the example host and a blank port writes 587', async () => {
		driver.answers = {
			[PICK]: 'smtp',
			'SMTP relay provider': 'custom',
			'SMTP host': 'mail.example.com',
			'SMTP port': '',
			'Use implicit TLS (port 465)? No = STARTTLS on 587': true,
			'SMTP username': 'u',
			'SMTP password': 'p',
		};
		const env = await pickSendingProvider();
		expect(callFor('SMTP host')).toMatchObject({
			placeholder: 'smtp.example.com',
			initialValue: '',
		});
		expect(env).toMatchObject({ SMTP_RELAY_PORT: '587', SMTP_RELAY_SECURE: 'true' });
		expect(probes.validateSmtpRelay).toHaveBeenCalledWith(
			expect.objectContaining({ port: 587, secure: true })
		);
	});

	it('writes nothing when the probe fails', async () => {
		probes.validateResendKey.mockResolvedValueOnce({
			ok: false,
			message: 'Resend rejected the key.',
		});
		driver.answers = { [PICK]: 'resend', 'Resend API key (re_...)': 're_bad' };
		await expect(pickSendingProvider()).resolves.toBeNull();
	});

	it('stops at the first cancelled prompt', async () => {
		driver.answers = { [PICK]: 'smtp', 'SMTP relay provider': 'mailgun' };
		driver.cancelAt = 'SMTP host';
		await expect(pickSendingProvider()).resolves.toBeNull();
		expect(driver.calls.map((c) => c.message)).toEqual([PICK, 'SMTP relay provider', 'SMTP host']);
		expect(probes.validateSmtpRelay).not.toHaveBeenCalled();
	});
});

describe('pickSendingProvider — prompt validation', () => {
	it('refuses an empty required credential at the prompt', async () => {
		driver.answers = { [PICK]: 'emailit', 'Emailit API key': 'em_live_key' };
		await pickSendingProvider();
		const validate = callFor('Emailit API key').validate;
		expect(validate).toBeTypeOf('function');
		expect(validate?.('')).toBe('Emailit API key is required.');
		expect(validate?.('   ')).toBeTruthy();
		expect(validate?.(undefined)).toBeTruthy();
		expect(validate?.('em_live_key')).toBeUndefined();
	});

	it('refuses an empty value for every required field of every kind', async () => {
		const answers: Record<string, unknown> = {
			'Resend API key (re_...)': 'k',
			'Emailit API key': 'k',
			'AWS SES region': 'r',
			AWS_ACCESS_KEY_ID: 'a',
			AWS_SECRET_ACCESS_KEY: 's',
			'SMTP relay provider': 'mailgun',
			'SMTP host': 'h',
			'SMTP port': '',
			'Use implicit TLS (port 465)? No = STARTTLS on 587': false,
			'SMTP username': 'u',
			'SMTP password': 'p',
		};
		for (const kind of ['resend', 'emailit', 'ses', 'smtp']) {
			driver.answers = { ...answers, [PICK]: kind };
			await pickSendingProvider();
		}
		const credentialPrompts = driver.calls.filter(
			(c) => (c.prompt === 'text' || c.prompt === 'password') && c.message !== 'SMTP port'
		);
		expect(credentialPrompts.map((c) => c.message)).toEqual([
			'Resend API key (re_...)',
			'Emailit API key',
			'AWS SES region',
			'AWS_ACCESS_KEY_ID',
			'AWS_SECRET_ACCESS_KEY',
			'SMTP host',
			'SMTP username',
			'SMTP password',
		]);
		for (const call of credentialPrompts) {
			expect(call.validate?.(''), call.message).toBe(`${call.message} is required.`);
		}
	});

	it('accepts a blank port but refuses one that is not a port', async () => {
		driver.answers = {
			[PICK]: 'smtp',
			'SMTP relay provider': 'mailgun',
			'SMTP host': 'h',
			'SMTP port': '587',
			'Use implicit TLS (port 465)? No = STARTTLS on 587': false,
			'SMTP username': 'u',
			'SMTP password': 'p',
		};
		await pickSendingProvider();
		const validate = callFor('SMTP port').validate;
		expect(validate?.('')).toBeUndefined();
		expect(validate?.('465')).toBeUndefined();
		expect(validate?.('58x')).toBe('Port must be digits only (leave blank for 587).');
		expect(validate?.('0')).toBe('Port must be between 1 and 65535.');
		expect(validate?.('65536')).toBe('Port must be between 1 and 65535.');
	});
});
