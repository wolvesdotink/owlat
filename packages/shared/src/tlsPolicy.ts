/**
 * The TLS server policy every Owlat mail listener presents: IMAPS on 993 and
 * the SMTP listeners on 25, 587 and 465.
 *
 * Pure data, exposed via the `@owlat/shared/tlsPolicy` subpath. A change to the
 * protocol floor or the cipher list is made here once and reaches every
 * listener, so 993 and 25 can never drift apart.
 */

/**
 * TLSv1.2 floor (RFC 8314 §4.1), AEAD-only ECDHE suites (GCM and
 * ChaCha20-Poly1305, so no CBC, RC4, 3DES or NULL), and the server's cipher
 * order. TLSv1.3 suites are not listed because OpenSSL configures them
 * separately and all of them are AEAD.
 */
export const HARDENED_SERVER_TLS_OPTIONS = {
	minVersion: 'TLSv1.2',
	ciphers: [
		'ECDHE-ECDSA-AES128-GCM-SHA256',
		'ECDHE-RSA-AES128-GCM-SHA256',
		'ECDHE-ECDSA-AES256-GCM-SHA384',
		'ECDHE-RSA-AES256-GCM-SHA384',
		'ECDHE-ECDSA-CHACHA20-POLY1305',
		'ECDHE-RSA-CHACHA20-POLY1305',
	].join(':'),
	honorCipherOrder: true,
} as const;
