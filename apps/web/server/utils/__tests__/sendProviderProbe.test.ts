import {
	CORE_SEND_PROVIDER_CATALOG_ENTRIES,
	type CoreSendProviderCatalogEntry,
} from '@owlat/shared/sendProviderCatalog';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installNitroGlobals } from './nitro';

const { validators } = vi.hoisted(() => ({
	validators: {
		validateResendKey: vi.fn(),
		validateEmailitKey: vi.fn(),
		validateSmtpRelay: vi.fn(),
	},
}));

vi.mock('@owlat/shared/setupValidators', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	...validators,
}));

const { parseProbeBody, runSendProviderProbe, hasSendProviderProbe, noProbeMessage } =
	await import('../sendProviderProbe');

const SMTP = { host: 'smtp.owlat.example', username: 'relay', password: 'secret' };

beforeEach(() => {
	installNitroGlobals();
	for (const [name, mock] of Object.entries(validators)) {
		mock.mockReset().mockResolvedValue({ ok: true, message: `ran ${name}` });
	}
});

describe('parseProbeBody', () => {
	it.each([undefined, null, {}, { provider: '' }, { provider: 42 }])(
		'answers 400 when provider is missing (%j)',
		(body) => {
			expect(() => parseProbeBody(body)).toThrow(
				expect.objectContaining({ statusCode: 400, message: 'provider is required.' })
			);
		}
	);

	it('keeps the string fields and the smtp block, and drops non-string keys', () => {
		expect(
			parseProbeBody({ provider: 'resend', apiKey: 'key', host: 'https://ph.example', smtp: SMTP })
		).toEqual({ provider: 'resend', apiKey: 'key', host: 'https://ph.example', smtp: SMTP });
		expect(parseProbeBody({ provider: 'resend', apiKey: 7, smtp: 'nope' })).toEqual({
			provider: 'resend',
			apiKey: undefined,
			host: undefined,
			smtp: undefined,
		});
	});
});

describe('runSendProviderProbe', () => {
	const entries: readonly CoreSendProviderCatalogEntry[] = CORE_SEND_PROVIDER_CATALOG_ENTRIES;
	const probed = entries.filter((entry) => entry.setupProbe !== undefined);

	it.each(probed.map((entry) => [entry.kind, entry.setupProbe!.validator] as const))(
		'%s runs the validator its catalog entry names (%s)',
		async (kind, validator) => {
			const input = parseProbeBody({ provider: kind, apiKey: 'key', smtp: SMTP });
			await expect(runSendProviderProbe(kind, input)).resolves.toEqual({
				ok: true,
				message: `ran ${validator}`,
			});
			for (const [name, mock] of Object.entries(validators)) {
				expect(mock, name).toHaveBeenCalledTimes(name === validator ? 1 : 0);
			}
			expect(hasSendProviderProbe(kind)).toBe(true);
		}
	);

	it.each(['resend', 'emailit'])('%s answers 400 without an apiKey', async (kind) => {
		await expect(
			runSendProviderProbe(kind, parseProbeBody({ provider: kind, smtp: SMTP }))
		).rejects.toMatchObject({ statusCode: 400, message: 'apiKey is required.' });
		expect(validators.validateResendKey).not.toHaveBeenCalled();
		expect(validators.validateEmailitKey).not.toHaveBeenCalled();
	});

	it.each([
		['no smtp block', undefined],
		['no host', { ...SMTP, host: '' }],
		['no username', { ...SMTP, username: undefined }],
		['no password', { ...SMTP, password: '' }],
	])('smtp answers 400 with %s', async (_label, smtp) => {
		await expect(
			runSendProviderProbe('smtp', parseProbeBody({ provider: 'smtp', apiKey: 'key', smtp }))
		).rejects.toMatchObject({
			statusCode: 400,
			message: 'smtp.host, smtp.username, and smtp.password are required.',
		});
		expect(validators.validateSmtpRelay).not.toHaveBeenCalled();
	});

	it('refuses a port given as a string instead of coercing it to 587', async () => {
		const input = parseProbeBody({ provider: 'smtp', smtp: { ...SMTP, port: '2525' } });
		await expect(runSendProviderProbe('smtp', input)).rejects.toMatchObject({
			statusCode: 400,
			message: 'smtp.port must be a number.',
		});
		expect(validators.validateSmtpRelay).not.toHaveBeenCalled();
	});

	it('defaults an absent port to 587 and secure to false', async () => {
		await runSendProviderProbe('smtp', parseProbeBody({ provider: 'smtp', smtp: SMTP }));
		expect(validators.validateSmtpRelay).toHaveBeenCalledWith({
			...SMTP,
			port: 587,
			secure: false,
		});
	});

	it('passes a numeric port through and treats only `true` as secure', async () => {
		await runSendProviderProbe(
			'smtp',
			parseProbeBody({ provider: 'smtp', smtp: { ...SMTP, port: 465, secure: 'yes' } })
		);
		expect(validators.validateSmtpRelay).toHaveBeenCalledWith({
			...SMTP,
			port: 465,
			secure: false,
		});
	});

	it.each([
		['ses', 'Amazon SES'],
		['mta', 'Owlat MTA'],
		['openai', 'this provider'],
	])('%s has no probe and gets the catalog-derived refusal', async (kind, label) => {
		expect(hasSendProviderProbe(kind)).toBe(false);
		const error = await runSendProviderProbe(
			kind,
			parseProbeBody({ provider: kind, apiKey: 'k' })
		).catch((caught: unknown) => caught);
		expect(error).toMatchObject({ statusCode: 400, message: noProbeMessage(kind) });
		const message = (error as Error).message;
		for (const entry of probed) expect(message).toContain(entry.label);
		expect(message).toContain('Emailit');
		expect(message).toContain('can be tested before applying');
		expect(message).toContain(
			`Apply the change, then use "Send a test email" to confirm ${label}.`
		);
		for (const mock of Object.values(validators)) expect(mock).not.toHaveBeenCalled();
	});
});
