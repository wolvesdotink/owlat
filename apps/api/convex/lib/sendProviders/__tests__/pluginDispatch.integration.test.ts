import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	events: [] as string[],
	send: vi.fn(),
}));

vi.mock('../../../plugins/sendTransportCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.mail-pack.postmark',
			pluginId: 'mail-pack',
			localId: 'postmark',
			label: 'Postmark',
			retryDelays: Object.freeze([0]),
			requiredEnvVars: Object.freeze([]),
			requiredCapability: 'send:transport',
		}),
	]),
}));

vi.mock('../../../plugins/sendTransportModules.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_MODULES: Object.freeze([
		Object.freeze({
			kind: 'plugin.mail-pack.postmark',
			pluginId: 'mail-pack',
			module: {
				parseExtras: (input: unknown) => input,
				send: (...args: unknown[]) => mocks.send(...args),
			},
		}),
	]),
}));

vi.mock('../../../plugins/plugins.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@acme/mail-pack',
			manifest: Object.freeze({
				id: 'mail-pack',
				version: '1.0.0',
				capabilities: Object.freeze(['send:transport']),
				flag: Object.freeze({ default: false, requiredEnvVars: Object.freeze([]) }),
			}),
		}),
	]),
}));

import { sendProviderDispatch } from '../dispatch';
import type { EmailSendParams, SendProviderKind } from '../types';
import { EmailErrorCode } from '../types';

const kind = 'plugin.mail-pack.postmark' as SendProviderKind;
const params: EmailSendParams = {
	to: 'to@example.com',
	from: 'from@example.com',
	subject: 'Subject',
	html: '<p>Hello</p>',
};

function fakeContext(authorization: boolean | readonly boolean[] = true) {
	const scheduled: Array<{ name: string; args: Record<string, unknown> }> = [];
	let authorizationIndex = 0;
	return {
		scheduled,
		ctx: {
			runMutation: vi.fn(async () => {
				mocks.events.push('authorize');
				if (typeof authorization === 'boolean') return authorization;
				return authorization[authorizationIndex++] ?? false;
			}),
			scheduler: {
				runAfter: vi.fn(
					async (_delay: number, reference: unknown, args: Record<string, unknown>) => {
						scheduled.push({ name: getFunctionName(reference as never), args });
					}
				),
			},
		},
	};
}

describe('hosted send transport dispatch', () => {
	it('authorizes immediately before the attempt and records health plus safe audit once', async () => {
		mocks.events.length = 0;
		mocks.send.mockImplementationOnce(async () => {
			mocks.events.push('send');
			return { success: true, id: 'message-id' };
		});
		const { ctx, scheduled } = fakeContext();

		const result = await sendProviderDispatch(ctx as never, kind, params, { stream: 'outbound' });

		expect(mocks.events).toEqual(['authorize', 'send']);
		expect(ctx.runMutation).toHaveBeenCalledWith(expect.anything(), {
			pluginId: 'mail-pack',
			providerKind: kind,
			priorAttempts: 0,
		});
		expect(result).toMatchObject({ attempts: 1, providerType: kind, result: { success: true } });
		expect(scheduled).toHaveLength(2);
		expect(scheduled[0]).toMatchObject({
			name: 'lib/sendProviders/health:recordSendResult',
			args: { providerType: kind, success: true },
		});
		expect(scheduled[1]).toEqual({
			name: 'plugins/sendTransportAuthorization:recordOutcome',
			args: { pluginId: 'mail-pack', providerKind: kind, attempts: 1, outcome: 'completed' },
		});
	});

	it('does not invoke plugin code when the last-moment authorization is denied', async () => {
		mocks.send.mockClear();
		const { ctx, scheduled } = fakeContext(false);
		const result = await sendProviderDispatch(ctx as never, kind, params);

		expect(mocks.send).not.toHaveBeenCalled();
		expect(result.attempts).toBe(0);
		expect(result.result).toMatchObject({ success: false, errorCode: EmailErrorCode.AUTH_FAILED });
		expect(scheduled).toHaveLength(1);
		expect(ctx.runMutation).toHaveBeenCalledWith(expect.anything(), {
			pluginId: 'mail-pack',
			providerKind: kind,
			priorAttempts: 0,
		});
	});

	it('reports one prior attempt when authorization is denied before a retry', async () => {
		mocks.send.mockReset().mockResolvedValueOnce({
			success: false,
			code: 'temporary_failure',
		});
		const { ctx, scheduled } = fakeContext([true, false]);

		const result = await sendProviderDispatch(ctx as never, kind, params);

		expect(mocks.send).toHaveBeenCalledOnce();
		expect(result.attempts).toBe(1);
		expect(ctx.runMutation).toHaveBeenNthCalledWith(2, expect.anything(), {
			pluginId: 'mail-pack',
			providerKind: kind,
			priorAttempts: 1,
		});
		expect(scheduled).toHaveLength(1);
	});

	it('rechecks authorization before retry and never retries an ambiguous timeout', async () => {
		mocks.send
			.mockResolvedValueOnce({ success: false, code: 'temporary_failure' })
			.mockResolvedValueOnce({ success: true, id: 'retry-success' });
		const retry = fakeContext();
		const retryResult = await sendProviderDispatch(retry.ctx as never, kind, params);
		expect(retry.ctx.runMutation).toHaveBeenCalledTimes(2);
		expect(retryResult.attempts).toBe(2);

		mocks.send.mockReset().mockResolvedValueOnce({
			success: false,
			code: 'ambiguous_timeout',
		});
		const ambiguous = fakeContext();
		const ambiguousResult = await sendProviderDispatch(ambiguous.ctx as never, kind, params);
		expect(ambiguous.ctx.runMutation).toHaveBeenCalledOnce();
		expect(mocks.send).toHaveBeenCalledOnce();
		expect(ambiguousResult.result).toMatchObject({
			success: false,
			errorCode: EmailErrorCode.AMBIGUOUS_TIMEOUT,
		});
	});
});
