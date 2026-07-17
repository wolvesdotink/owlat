'use node';

/**
 * Backend composition seam for Tier-2 signed synchronous hooks.
 *
 * It wires the pure host engine (`invokeSyncHook`) to this deployment's real
 * dependencies: the SSRF-guarded Node transport, the shared injection scrubber,
 * a cryptographic nonce source, and best-effort per-instance circuit-breaker and
 * response-nonce stores. PP-22 (connected-app domain) resolves a
 * `SyncHookDescriptor` from stored app records + decrypted secrets and calls
 * `invokeConnectedAppHook`; PP-25 adds durable delivery logging around it.
 *
 * The engine treats the descriptor as opaque configuration, so this module holds
 * no policy of its own — every security decision (signing, verification, replay,
 * fail-closed gating, scrubbing) lives in `@owlat/plugin-host`.
 */

import { randomUUID } from 'node:crypto';
import type { JsonObject, SyncHookDescriptor } from '@owlat/plugin-kit';
import {
	createInMemoryCircuitBreakerStore,
	createInMemorySeenNonceStore,
	invokeSyncHook,
	type CircuitBreakerStore,
	type SeenNonceStore,
	type SyncHookResult,
	type SyncHookTransport,
} from '@owlat/plugin-host';
import { scrubForInjection } from '../../assistant/prompt';
import { nodeSyncHookTransport } from './hookTransport';

export interface ConnectedAppHookInvoker {
	invoke(descriptor: SyncHookDescriptor, payload: JsonObject): Promise<SyncHookResult>;
}

export interface ConnectedAppHookInvokerOptions {
	/** Override the wire transport (tests inject a local server). */
	readonly transport?: SyncHookTransport;
	/** Override the injection scrubber (defaults to the shared prompt scrubber). */
	readonly scrubPromptInjection?: (text: string) => string;
	/** Override the circuit-breaker store (defaults to per-instance in-memory). */
	readonly circuit?: CircuitBreakerStore;
	/** Override the response-nonce replay store (defaults to per-instance). */
	readonly seenNonces?: SeenNonceStore;
	/** Override the clock (tests). */
	readonly now?: () => number;
	/** Override the nonce source (tests). */
	readonly randomNonce?: () => string;
}

/**
 * Build an invoker. The default circuit-breaker and nonce stores are
 * per-process best-effort layers: replay defense's primary guarantees are the
 * request-nonce binding and timestamp freshness enforced in the engine, so a
 * per-instance nonce cache never weakens the invariant — it only adds a second
 * line. Durable cross-instance state is deferred to PP-25.
 */
export function createConnectedAppHookInvoker(
	options: ConnectedAppHookInvokerOptions = {}
): ConnectedAppHookInvoker {
	const now = options.now ?? Date.now;
	const circuit = options.circuit ?? createInMemoryCircuitBreakerStore();
	const seenNonces = options.seenNonces ?? createInMemorySeenNonceStore(now);
	const transport = options.transport ?? nodeSyncHookTransport;
	const scrubPromptInjection = options.scrubPromptInjection ?? scrubForInjection;
	const randomNonce = options.randomNonce ?? (() => randomUUID());

	return {
		invoke(descriptor, payload) {
			return invokeSyncHook(descriptor, payload, {
				transport,
				now,
				randomNonce,
				scrubPromptInjection,
				seenNonces,
				circuit,
			});
		},
	};
}
