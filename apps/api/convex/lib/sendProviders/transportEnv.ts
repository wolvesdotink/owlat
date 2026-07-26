/**
 * Per-transport configuration reads.
 *
 * Each send adapter resolves ITS OWN sealed config from the transport record it
 * is handed, rather than from a deployment-wide variable. The default instance
 * reads the unsuffixed, typed `EnvKey` exactly as before (so a single-transport
 * deployment is unchanged down to the thrown message); a named instance reads
 * the same base name under its `__<INSTANCEKEY>` suffix.
 *
 * Values returned here are credentials. They stay inside the adapter that asked
 * for them: never logged, never put on a dispatch result, never returned to a
 * client.
 */

import { getOptional, getSendTransportEnv, type EnvKey } from '../env';
import { sendTransportEnvName, type SendTransportRecord } from './transports';

/** Read an optional config value for this transport instance. */
export function transportEnvOptional(
	transport: SendTransportRecord,
	key: EnvKey
): string | undefined {
	if (transport.instanceKey === null) return getOptional(key);
	return getSendTransportEnv(sendTransportEnvName(key, transport.instanceKey));
}

/**
 * Read a required config value for this transport instance. Throws with the
 * INSTANCE-RESOLVED variable name — the same message shape `getRequired`
 * produces, so the default instance's failure text is unchanged.
 */
export function transportEnvRequired(transport: SendTransportRecord, key: EnvKey): string {
	const value = transportEnvOptional(transport, key);
	if (!value) {
		throw new Error(
			`Missing required environment variable: ${sendTransportEnvName(key, transport.instanceKey)}`
		);
	}
	return value;
}

/**
 * Boolean parse for this transport instance. Same truthy set as `getBoolean`:
 * 'true', '1', 'yes', 'on' (case-insensitive); anything else is false.
 */
export function transportEnvBoolean(transport: SendTransportRecord, key: EnvKey): boolean {
	const value = transportEnvOptional(transport, key)?.toLowerCase();
	return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}
