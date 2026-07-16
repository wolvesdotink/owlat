import { describe, expect, it, vi } from 'vitest';
import { parsePluginId, pluginSendTransportKind } from '@owlat/plugin-kit';
import { createHostedSendProvider, parseHostedSendTransportModule } from '../pluginProvider';
import { EmailErrorCode } from '../types';

const kind = pluginSendTransportKind(parsePluginId('mail-pack'), 'postmark');
const params = {
	to: 'to@example.com',
	from: 'from@example.com',
	subject: 'Subject',
	html: '<p>Hello</p>',
};

describe('bundled plugin send transport boundary', () => {
	it('parses extras, performs one attempt, and normalizes a success', async () => {
		const parseExtras = vi.fn((input: unknown) => ({ token: String(input) }));
		const send = vi.fn(async () => ({ success: true as const, id: 'provider-id' }));
		const provider = createHostedSendProvider(kind, [10], { parseExtras, send });

		await expect(provider.sendEmail(params, 'opaque')).resolves.toEqual({
			success: true,
			id: 'provider-id',
		});
		expect(parseExtras).toHaveBeenCalledWith('opaque');
		expect(send).toHaveBeenCalledOnce();
		expect(send).toHaveBeenCalledWith(params, { token: 'opaque' });
	});

	it.each([
		['rate_limited', EmailErrorCode.RATE_LIMIT],
		['temporary_failure', EmailErrorCode.SERVER_ERROR],
		['ambiguous_timeout', EmailErrorCode.AMBIGUOUS_TIMEOUT],
		['invalid_recipient', EmailErrorCode.INVALID_RECIPIENT],
		['invalid_sender', EmailErrorCode.INVALID_SENDER],
		['authentication_failed', EmailErrorCode.AUTH_FAILED],
		['content_rejected', EmailErrorCode.CONTENT_REJECTED],
		['unknown', EmailErrorCode.UNKNOWN],
	] as const)('maps %s to the host error taxonomy', async (code, errorCode) => {
		const provider = createHostedSendProvider(kind, [], {
			parseExtras: () => undefined,
			send: async () => ({ success: false, code }),
		});
		await expect(provider.sendEmail(params)).resolves.toEqual({
			success: false,
			errorCode,
			errorMessage: 'Bundled send transport failed',
		});
	});

	it('fails closed without leaking parser, adapter, or malformed-result errors', async () => {
		for (const module of [
			{
				parseExtras: () => {
					throw new Error('secret parser detail');
				},
				send: vi.fn(),
			},
			{
				parseExtras: () => undefined,
				send: async () => {
					throw new Error('secret API key');
				},
			},
			{ parseExtras: () => undefined, send: async () => ({ success: true, id: '' }) },
			{ parseExtras: () => undefined, send: async () => ({ success: false, code: 'invented' }) },
		]) {
			const provider = createHostedSendProvider(kind, [], module);
			await expect(provider.sendEmail(params)).resolves.toEqual({
				success: false,
				errorCode: EmailErrorCode.UNKNOWN,
				errorMessage: 'Bundled send transport failed',
			});
		}
	});

	it('rejects accessors, inherited objects, and surplus module surface without invoking getters', () => {
		let getterReads = 0;
		const accessor = Object.defineProperty({ send: vi.fn() }, 'parseExtras', {
			enumerable: true,
			get() {
				getterReads += 1;
				return vi.fn();
			},
		});
		expect(() => parseHostedSendTransportModule(accessor)).toThrow();
		expect(() =>
			parseHostedSendTransportModule({ parseExtras: vi.fn(), send: vi.fn(), secret: 'x' })
		).toThrow();
		expect(() =>
			parseHostedSendTransportModule(
				Object.assign(Object.create({ inherited: true }), {
					parseExtras: vi.fn(),
					send: vi.fn(),
				})
			)
		).toThrow();
		expect(getterReads).toBe(0);
	});
});
