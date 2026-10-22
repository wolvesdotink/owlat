import { afterEach, describe, expect, it, vi } from 'vitest';
import { logEvent } from '../runtimeLog';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('logEvent', () => {
	it.each([
		['debug', 'debug'],
		['info', 'log'],
		['warn', 'warn'],
		['error', 'error'],
	] as const)('writes a %s event as one JSON line through console.%s', (severity, method) => {
		const spy = vi.spyOn(console, method).mockImplementation(() => undefined);

		logEvent(
			'delivery.dispatch.completed',
			{ orgId: 'org_1', correlationId: 'txn_abc', sendId: undefined, outcome: 'accepted' },
			severity
		);

		expect(spy).toHaveBeenCalledTimes(1);
		const [line, ...rest] = spy.mock.calls[0]!;
		expect(rest).toEqual([]);
		expect(JSON.parse(line as string)).toEqual({
			event: 'delivery.dispatch.completed',
			level: severity,
			orgId: 'org_1',
			correlationId: 'txn_abc',
			outcome: 'accepted',
		});
	});

	it('defaults to info with no fields', () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

		logEvent('postbox.forward.sent');

		expect(JSON.parse(spy.mock.calls[0]![0] as string)).toEqual({
			event: 'postbox.forward.sent',
			level: 'info',
		});
	});
});
