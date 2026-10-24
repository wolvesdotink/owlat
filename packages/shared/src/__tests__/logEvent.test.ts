import { describe, expect, it } from 'vitest';
import { logEventBindings, logEventRecord } from '../logEvent';

describe('logEventBindings', () => {
	it('keeps only the fixed keys and drops undefined values', () => {
		const wider = {
			orgId: 'org_1',
			messageId: 'send_1',
			sendId: undefined,
			correlationId: 'txn_abc',
			durationMs: 12,
			outcome: 'accepted',
			// A caller spreading a wider object must not widen the contract.
			organizationId: 'org_1',
			to: 'person@example.com',
		};
		expect(logEventBindings(wider)).toEqual({
			orgId: 'org_1',
			messageId: 'send_1',
			correlationId: 'txn_abc',
			durationMs: 12,
			outcome: 'accepted',
		});
	});

	it('keeps a primitive detail and drops it when every value is undefined', () => {
		expect(logEventBindings({ detail: { status: 409, retry: false, note: null } })).toEqual({
			detail: { status: 409, retry: false, note: null },
		});
		expect(logEventBindings({ detail: { status: undefined } })).toEqual({});
	});
});

describe('logEventRecord', () => {
	it('puts the event name and level first, then the payload', () => {
		const record = logEventRecord('delivery.dispatch.completed', 'warn', {
			orgId: 'org_1',
			outcome: 'refused',
		});
		expect(Object.keys(record)).toEqual(['event', 'level', 'orgId', 'outcome']);
		expect(record).toEqual({
			event: 'delivery.dispatch.completed',
			level: 'warn',
			orgId: 'org_1',
			outcome: 'refused',
		});
	});

	it.each(['Delivery.Dispatch', 'dispatch', 'delivery..dispatch', '[Outbound] failed', ''])(
		're-files the malformed name %j instead of throwing',
		(name) => {
			const record = logEventRecord(name, 'error', { messageId: 'm1', detail: { status: 1 } });
			expect(record).toEqual({
				event: 'log.malformed_event',
				level: 'error',
				messageId: 'm1',
				detail: { status: 1, eventName: name },
			});
		}
	);
});
