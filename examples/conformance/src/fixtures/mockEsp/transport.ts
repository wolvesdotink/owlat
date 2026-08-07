/**
 * MOCK ESP — the SEND half of the bundle.
 *
 * A fixture, so the "network attempt" is a deterministic in-memory call rather
 * than a `fetch`. Everything AROUND the call is real, because that is what the
 * parity suite reads: the module reads its credentials from the instance
 * configuration it is handed (never from `process.env`, which would resolve the
 * deployment-default instance whichever id the send was addressed to), it
 * returns the kit's typed attempt shape rather than host error text, and its
 * `parseExtras` is the sole unknown-input boundary.
 *
 * The recorded attempts are exported so a test can assert WHICH credential set a
 * send went out on — the property named instances exist for.
 */

import type {
	PluginSendAttempt,
	PluginSendDispatchContext,
	PluginSendTransportConfig,
	PluginSendTransportModule,
	PluginSendTransportParams,
} from '@owlat/plugin-kit';
// The names the MANIFEST declares, read from the one module that declares them:
// a literal here would go on being read after a rename, as a credential the host
// never populates.
import { MOCK_ESP_REGION_ENV, MOCK_ESP_TOKEN_ENV } from './envNames';

/** The transport's own extras: a tag the provider would echo on its events. */
export interface MockEspExtras {
	readonly campaignTag?: string;
}

/** One recorded attempt, for the suite to read back. */
export interface MockEspAttempt {
	readonly to: string;
	readonly instanceKey: string | null;
	readonly token: string | undefined;
	readonly region: string | undefined;
	readonly extras: MockEspExtras;
}

const ATTEMPTS: MockEspAttempt[] = [];

/**
 * Every attempt this fixture has made, oldest first — a SNAPSHOT, never the live
 * array.
 *
 * `readonly` stops a caller mutating the log; it does not stop the log mutating
 * under a caller. A case written in the natural before/after shape (`const before
 * = mockEspAttempts()`, dispatch, compare) would otherwise be comparing one array
 * to itself and could never fail. This fixture is the reference an author copies,
 * so the reader hands back a copy.
 */
export function mockEspAttempts(): readonly MockEspAttempt[] {
	return [...ATTEMPTS];
}

/** Forget the recorded attempts (per-case isolation). */
export function resetMockEspAttempts(): void {
	ATTEMPTS.length = 0;
}

export const mockEspTransport: PluginSendTransportModule<MockEspExtras> = {
	/**
	 * The unknown-input boundary. Anything that is not this transport's own extras
	 * shape is REFUSED rather than coerced — including the host's re-validation of
	 * what `buildDispatchExtras` below returned, which passes back through here.
	 */
	parseExtras(input: unknown): MockEspExtras {
		if (input === undefined || input === null) return {};
		if (typeof input !== 'object') throw new TypeError('mock-esp: extras must be an object');
		const tag = (input as Record<string, unknown>)['campaignTag'];
		if (tag === undefined) return {};
		if (typeof tag !== 'string') throw new TypeError('mock-esp: campaignTag must be a string');
		return { campaignTag: tag };
	},

	async send(
		params: PluginSendTransportParams,
		extras: MockEspExtras,
		config: PluginSendTransportConfig
	): Promise<PluginSendAttempt> {
		const token = config.env[MOCK_ESP_TOKEN_ENV];
		ATTEMPTS.push({
			to: params.to,
			instanceKey: config.instanceKey,
			token,
			region: config.env[MOCK_ESP_REGION_ENV],
			extras,
		});
		// The host fails the attempt before `send` runs when a REQUIRED variable is
		// unset, so this branch is defence in depth rather than the gate.
		if (!token) return { success: false, code: 'authentication_failed' };
		return { success: true, id: `mock-esp-${ATTEMPTS.length}` };
	},

	/**
	 * Pure and synchronous by contract: the host resolves every fact on the input
	 * once, so this adds no round trip to the send path.
	 */
	buildDispatchExtras(context: PluginSendDispatchContext): unknown {
		return { campaignTag: context.messageType };
	},
};
