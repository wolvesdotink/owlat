/**
 * Outbound TLS posture for the built-in MTA's direct-MX delivery (env
 * `OUTBOUND_TLS_MODE`). The single source of truth for the env contract shared
 * between the MTA config, the MTA TLS-policy resolver, and the web setup wizard.
 *
 *  - `opportunistic` — encrypt when the receiver offers STARTTLS, but never fail
 *    delivery on a missing or unverifiable certificate (RFC 7435). The default,
 *    byte-identical to the historic behaviour.
 *  - `require` — the handshake MUST upgrade to TLS; the certificate is not
 *    verified (encrypt-always, tolerate self-signed MX certs).
 *  - `require-verified` — the handshake MUST upgrade to TLS AND the certificate
 *    must verify against the WebPKI trust store. Can bounce mail to receivers
 *    with broken/self-signed TLS.
 */
export type OutboundTlsMode = 'opportunistic' | 'require' | 'require-verified';

/** The set of valid {@link OutboundTlsMode} values, in strictness order. */
export const OUTBOUND_TLS_MODES: readonly OutboundTlsMode[] = [
	'opportunistic',
	'require',
	'require-verified',
] as const;

/** Narrow an untrusted string to a valid {@link OutboundTlsMode}. */
export function isOutboundTlsMode(value: string): value is OutboundTlsMode {
	return (OUTBOUND_TLS_MODES as readonly string[]).includes(value);
}
