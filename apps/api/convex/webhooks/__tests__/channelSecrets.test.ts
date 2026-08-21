import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import { missingChannelSecretResult, resolveChannelInboundSecret } from '../channelSecrets';

const ENV_VAR = 'GENERIC_WEBHOOK_SECRET';

function ctxReturning(stored: string | null): ActionCtx {
	return { runAction: vi.fn().mockResolvedValue(stored) } as unknown as ActionCtx;
}

function ctxThrowing(): ActionCtx {
	return {
		runAction: vi.fn().mockRejectedValue(new Error('vault unavailable')),
	} as unknown as ActionCtx;
}

afterEach(() => {
	delete process.env[ENV_VAR];
	vi.restoreAllMocks();
});

describe('resolveChannelInboundSecret', () => {
	it('prefers the credential stored on the channel over the env var', async () => {
		process.env[ENV_VAR] = 'from-env';
		const secret = await resolveChannelInboundSecret(
			'generic',
			'signature',
			ENV_VAR,
			ctxReturning('from-channel-form')
		);
		expect(secret).toBe('from-channel-form');
	});

	it('asks the vault for the requested channel and field', async () => {
		const ctx = ctxReturning('token');
		await resolveChannelInboundSecret('whatsapp', 'verifyToken', 'META_VERIFY_TOKEN', ctx);
		expect(ctx.runAction).toHaveBeenCalledWith(expect.anything(), {
			channel: 'whatsapp',
			field: 'verifyToken',
		});
	});

	it('falls back to the env var when the channel has no stored credential', async () => {
		process.env[ENV_VAR] = 'from-env';
		const secret = await resolveChannelInboundSecret(
			'generic',
			'signature',
			ENV_VAR,
			ctxReturning(null)
		);
		expect(secret).toBe('from-env');
	});

	it('falls back to the env var when the vault read throws', async () => {
		process.env[ENV_VAR] = 'from-env';
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const secret = await resolveChannelInboundSecret(
			'generic',
			'signature',
			ENV_VAR,
			ctxThrowing()
		);
		expect(secret).toBe('from-env');
	});

	it('resolves env-only when called without a ctx', async () => {
		process.env[ENV_VAR] = 'from-env';
		expect(await resolveChannelInboundSecret('generic', 'signature', ENV_VAR)).toBe('from-env');
	});

	it('returns null when neither source has a secret', async () => {
		expect(
			await resolveChannelInboundSecret('generic', 'signature', ENV_VAR, ctxReturning(null))
		).toBeNull();
	});
});

describe('missingChannelSecretResult', () => {
	it('fails closed with a 503 naming both the env var and the form field', () => {
		const result = missingChannelSecretResult(ENV_VAR, 'webhook channel Secret Key');
		expect(result.status).toBe(503);
		expect(result.reason).toContain(ENV_VAR);
		expect(result.reason).toContain('webhook channel Secret Key');
	});
});
