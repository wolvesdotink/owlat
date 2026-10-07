/**
 * Clearsigned messages made by GnuPG (`gpg --clearsign`, an Ed25519 test key
 * for alice@sender.test), not by openpgp.js, so the verifier is held to an
 * independent implementation's output. Both verify with `gpg --verify`; with
 * `aus` turned into `a<CR>us` both are a BAD signature to GnuPG (#1300).
 *
 * The messages are base64 so their 8-bit octets survive as they were signed.
 */

/** The test key's public half. */
export const GPG_PUBLIC_KEY = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mDMEasWK+hYJKwYBBAHaRw8BAQdA44FL+kc9qC9vTfskskYR7K8PwpbtOVKQ+wzJ
ug33Ke20GUFsaWNlIDxhbGljZUBzZW5kZXIudGVzdD6IjwQTFgoAOBYhBIghxjyk
jpR2bgZtP2CBXEFS3P21BQJqxYr6AhsDBQsJCAcCBhUKCQgLAgQWAgMBAh4BAheA
AAoJEGCBXEFS3P21hfkBALiegsffYzBviG8HXD6CNdWImgb8VL3iCWUE/5uNUc5k
APihMD7O+aj+eUUUOjqlSBvsp44T1EPit36Nluycd70L
=K69/
-----END PGP PUBLIC KEY BLOCK-----`;

/** `Viele Gruesse aus Koeln,\nAlice\n`, clearsigned. ASCII only. */
export const GPG_CLEARSIGNED_ASCII_BASE64 =
	'LS0tLS1CRUdJTiBQR1AgU0lHTkVEIE1FU1NBR0UtLS0tLQpIYXNoOiBTSEE1MTIKClZpZWxlIEdydWVzc2UgYXVzIE' +
	'tvZWxuLApBbGljZQotLS0tLUJFR0lOIFBHUCBTSUdOQVRVUkUtLS0tLQoKaUhVRUFSWUtBQjBXSVFTSUljWThwSTZV' +
	'ZG00R2JUOWdnVnhCVXR6OXRRVUNhc1dUbVFBS0NSQmdnVnhCVXR6OQp0V2ZVQVFDUCs1RnJSNjlWK21WSG1jWmpDOV' +
	'FKSG9hd0c4VjRXNkhEaXBVT2pMdExvQUVBNTQxM1M3VVVBbjQ3CmdvY3ZIbTl0bHVKck51S295VDkwc0lrU1NxTzBn' +
	'QVE9Cj1sRUpHCi0tLS0tRU5EIFBHUCBTSUdOQVRVUkUtLS0tLQo=';

/** `Grüße aus Köln,\nAlice\n` in ISO-8859-1 octets, clearsigned. */
export const GPG_CLEARSIGNED_LATIN1_BASE64 =
	'LS0tLS1CRUdJTiBQR1AgU0lHTkVEIE1FU1NBR0UtLS0tLQpIYXNoOiBTSEE1MTIKCkdy/N9lIGF1cyBL9mxuLApBbG' +
	'ljZQotLS0tLUJFR0lOIFBHUCBTSUdOQVRVUkUtLS0tLQoKaUhVRUFSWUtBQjBXSVFTSUljWThwSTZVZG00R2JUOWdn' +
	'VnhCVXR6OXRRVUNhc1dUbVFBS0NSQmdnVnhCVXR6OQp0WitjQVFES3RHdGtBTlBJTktRaWJDOUlrT3FmTjFnVk96cU' +
	'xmNkNVK3hCb2loT3NFd0VBaDE2NXl5dXd0bWxJCmdCdVRTMEFtMHF4YmtPUWR2WE5MYU5nOHV2TGpaUUU9Cj1UckJB' +
	'Ci0tLS0tRU5EIFBHUCBTSUdOQVRVUkUtLS0tLQo=';
