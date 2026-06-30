/**
 * Client simulator registry primitive.
 *
 * Lives in its own module so the per-client simulator files (gmail.ts,
 * outlookDesktop.ts, …) can import registerClientSimulator without
 * pulling in the side-effect imports from ./index.ts, which would
 * otherwise create a circular dependency through the temporal dead zone.
 */

import { createRegistry } from '@owlat/shared/registry';
import type { TargetClient } from '../types';

/**
 * Transform that degrades HTML to approximate a target client's rendering.
 * Receives post-render HTML and returns the degraded HTML.
 */
export type ClientSimulator = (html: string) => string;

/**
 * Registry of installed client simulators.
 *
 * Built-in simulators register themselves at module load via the
 * side-effect imports in ./index.ts.
 */
export const clientSimulators = createRegistry<TargetClient, ClientSimulator>(
	'clientSimulators',
);

/**
 * Install a client simulator. Replaces any prior simulator for the same client.
 */
export function registerClientSimulator(
	client: TargetClient,
	simulator: ClientSimulator,
): void {
	clientSimulators.register(client, simulator);
}

/**
 * Remove an installed client simulator. Returns true if anything was removed.
 */
export function unregisterClientSimulator(client: TargetClient): boolean {
	return clientSimulators.unregister(client);
}

/**
 * Apply the simulator for the given client. Unknown clients pass HTML through.
 */
export function simulateClient(html: string, client: TargetClient): string {
	const simulator = clientSimulators.get(client);
	return simulator ? simulator(html) : html;
}
