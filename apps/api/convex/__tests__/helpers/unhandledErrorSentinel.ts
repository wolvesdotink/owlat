/**
 * Shared by the sentinel and the gate that spawns it. Kept out of both test
 * files so importing the constants never registers either file's tests.
 */
export const SENTINEL_SWITCH = 'OWLAT_UNHANDLED_ERROR_SENTINEL';
export const SENTINEL_MESSAGE = 'unhandled-error sentinel: this rejection is deliberately leaked';
