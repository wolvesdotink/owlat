/**
 * The kill-test world's JSON boundary. A hold request of the wrong shape must
 * never arm a rule (a rule that never matches lets the scenario run without
 * its kill and pass), and a state answer of the wrong shape must stop the run
 * before the oracle reads it.
 */
import { describe, expect, it } from 'vitest';
import {
	decodeHoldRules,
	decodeHoldUids,
	decodeWorldState,
	parseWire,
	WireError,
} from '../kill-tests/world/wire';

describe('kill-test control requests', () => {
	it('arm well-formed hold rules and UIDs', () => {
		expect(
			decodeHoldRules(
				parseWire('{"rules":[{"rcpt":"a3@a.sink.owlat.test","point":"data"}]}', 'hold')
			)
		).toEqual([{ rcpt: 'a3@a.sink.owlat.test', point: 'data' }]);
		expect(decodeHoldUids(parseWire('{"uids":[6]}', 'hold'))).toEqual([6]);
	});

	it('refuse a hold request of the wrong shape', () => {
		const rules: unknown[] = [
			null,
			[],
			{},
			{ rules: { rcpt: 'a', point: 'data' } },
			{ rules: [{ rcpt: 'a', point: 'body' }] },
			{ rules: [{ rcpt: 7, point: 'dot' }] },
			{ rules: ['a'] },
		];
		for (const body of rules) expect(() => decodeHoldRules(body)).toThrow(WireError);
		for (const body of [
			{ uids: '6' },
			{ uids: ['6'] },
			{ uids: [6.5] },
			{ uids: [0] },
			{ uid: [6] },
		])
			expect(() => decodeHoldUids(body)).toThrow(WireError);
		expect(() => parseWire('rules=a', 'control request')).toThrow('control request is not JSON');
	});
});

describe('kill-test world state', () => {
	const state = {
		events: [{ seq: 1, key: 'mta.terminal:m1', detail: null }],
		smtp: [
			{
				session: 1,
				mailFrom: 'a@b',
				rcpts: ['a1@a.sink.owlat.test'],
				state: 'accepted',
				bodyReceived: true,
			},
		],
		webhooks: [{ event: 'sent', messageId: 'm1', backendStatus: 200 }],
		ingestCalls: [{ messageId: '<6@x>', remoteUid: 6, outcome: 'stored', held: true }],
	};

	it('hands the oracle what the world recorded', () => {
		expect(decodeWorldState(state)).toEqual({
			smtp: [{ rcpts: ['a1@a.sink.owlat.test'], bodyReceived: true }],
			webhooks: state.webhooks,
			ingestCalls: state.ingestCalls,
		});
	});

	it('refuses a state the oracle would misread', () => {
		const broken: [Record<string, unknown>, string][] = [
			[{ smtp: undefined }, 'smtp must be an array'],
			[
				{ smtp: [{ rcpts: 'a1@a.sink.owlat.test', bodyReceived: true }] },
				'smtp[0].rcpts must be an array',
			],
			[{ smtp: [{ rcpts: [], bodyReceived: 'yes' }] }, 'smtp[0].bodyReceived must be a boolean'],
			[
				{ webhooks: [{ event: 'sent', messageId: 'm1', backendStatus: '200' }] },
				'webhooks[0].backendStatus must be an integer',
			],
			[
				{ ingestCalls: [{ ...state.ingestCalls[0], outcome: 'lost' }] },
				'ingestCalls[0].outcome must be stored, duplicate or other',
			],
			[
				{ ingestCalls: [{ ...state.ingestCalls[0], remoteUid: null }] },
				'ingestCalls[0].remoteUid must be an integer',
			],
		];
		for (const [patch, message] of broken)
			expect(() => decodeWorldState({ ...state, ...patch })).toThrow(message);
		expect(() => decodeWorldState([])).toThrow('world state must be an object');
	});
});
