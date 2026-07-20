/**
 * Fixed DKIM key material for the golden .eml corpus (piece R2).
 *
 * A golden is only useful if it is byte-for-byte reproducible, and a DKIM
 * signature is only reproducible if the SIGNING KEY and the SIGN TIME are both
 * fixed. So — unlike the runtime signer, and unlike `dkim.test.ts` which mints a
 * throwaway key with `generateKeyPairSync` each run — the goldens are signed with
 * this ONE checked-in 2048-bit RSA key and one frozen timestamp. That makes
 * `goldens:update` deterministic (re-running it produces identical bytes) and
 * lets the byte-diff test assert exact equality against the committed files.
 *
 * This key EXISTS ONLY to sign test fixtures. It signs the domain `owlat.test`
 * (a reserved TLD that can never receive real mail) under a test selector, is
 * never referenced by any runtime code path, and grants no access to anything.
 * The matching public half is exposed as {@link GOLDEN_DKIM_TXT_RECORD} so the
 * byte-diff test can re-verify every golden signature under mailauth on every CI
 * run (the three-way `signer -> wire -> mailauth` proof, per locked I6/I1).
 */

/** The signing domain — a reserved TLD, so these goldens can never be live mail. */
export const GOLDEN_DKIM_DOMAIN = 'owlat.test';

/** The DKIM selector under `_domainkey.owlat.test`. */
export const GOLDEN_DKIM_SELECTOR = 'golden2026';

/**
 * A frozen signature timestamp (ms since epoch) so the `t=` tag — and therefore
 * the whole `DKIM-Signature` — is identical on every regeneration.
 */
export const GOLDEN_SIGN_TIME_MS = 1_760_000_000_000;

/** The fixed test private key (PKCS#8 PEM). Signs test fixtures ONLY. */
export const GOLDEN_DKIM_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDcNiNwaTzLhUSH
3BrSBhLdgW1sBriYI+rARGwHkLW8QEMSOs1Pq8gtdW7+4POeYrlPy/8LxlbECImq
+YBxq1KxQX6p8iUUPK3fs0QxIOgmtT71O8EUqjXU1Arx/cuNjV5SORlUU3ld5PTP
ogIlKmpL7O/c0gf1fWMF1jrjlnK3L3/IgrqfaF2hHXH4i6P3w7Ka2GUfHkUyIUnh
hvo/sU88SNRXxAWXjU1GvVg9IsyMcEhsh7loDbi8CQiCtUxVM0oJ0McZlhj7rokt
LIcOufzQg+HqPd97/Cqo0kYsNIWDjIqNNORaRGywPpMYriME1pmMko5/l/1Yij3L
LmCp61j7AgMBAAECggEABrjkXHWDjjCGrTsL2o0Mg5SEeZkiID4G1+p+yonuJYDO
S1heLug7vexPmho8QmgZgUhLhD/mvPWhwwVgy8q2Eh30tub8a/sgnhHD3otDN8NH
ciCdcUfZr6IiP2bgkUHXUKoLjhmj1jju1dPIcWGZ4xcPIqEkVKfvBbbKqQRNT8gy
uDfzHLgFxcq35w15obvnHk9pRehKYuVFKN8M+4642q4Zc5dO9Q9c2Gl3oXRFsXA5
Fdzyt6RiWc3p5yJtaknGTFPvKYdrOpJ3WpmFkTqtsKF2Oylmb30HImSOUcnRsFtc
RquWil68utnSpzYehs5VUgbF/cByplVaZLDIOGHdoQKBgQDv4aft6jp2WbbGKjms
oaqbQDaEc2X8x9CxnLr5oUYp7LNuLMQrjycjb24Drw5wQ4472bhG69v9lVyBKz1J
aY2Mx1F7ygJkIYd8PLRp6ayATwJRMZbfOaGVmuJxQDBim1byVBs6fl4LaLYdMd1G
NB9n/Xa87It3iZoVA8nKZiBIqwKBgQDrAiCSu3u+Wt1787ais4tAeq7UWH+O7IV2
ItWk0W+skOawZlPaML4pdd2RJF69D4qVlXEq55edcJoWpwtTxwavTH/sJoeBGwri
Azf71G5Widr6G4LxGOLbw20Q8WyLC5jjfHN3MQkfH/KhOZxNyhRb62HweVLZprTl
l+wcF3TQ8QKBgQDbh89Qi6CvORFtL62SkG17IXwDITz/5rnWIhJ3bCGzMp1PQgbR
unPeGRc8pdN36Etd+LWNqkKtQyjiSXkQG1pgsPSgblJb4teEWmXd2+1zi1sahWCG
r85yBMohTNY7F+Cta01z7bwRguXPuBfCLOdlGvC0m2JTpoltnAbrhSUcewKBgQCn
OH9HCYL2ox9geL1nLkyS1/kY/dPeNiyNMCJHQgOtjfmoYVefNPnK9KRxB6kl7C4X
XBwHhH1cuOfb4Ibt2PvHtq57sbrPwhdPVSz701+j0jnvp63XsnaSG4+6857hnaHv
lPlwQYMVE52I3T58F6O++FFbVGkAmF+10xFdt88WcQKBgQDEH/so04FDiP7QnzAI
LbjlAXOWQevXL+TvOFe7ANWFznXAYGfzo8c8f9Zn8tp7vZgcy0k2sekm5rLXYjhB
ZbgtDVQjs4PVHh+5KWgJAgzQVTeGq6Tv9VNsOEhLCFoS2aWHcax1ZGoUtrQu2lcs
Bonw6TrLFO8YwwkWdsY3NagbDw==
-----END PRIVATE KEY-----
`;

/** The base64 SPKI public half, as published in the DKIM `p=` DNS tag. */
const GOLDEN_DKIM_PUBLIC_P =
	'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3DYjcGk8y4VEh9wa0gYS3YFtbAa4mCPqwERsB5C1vEBDEjrNT6vILXVu/uDznmK5T8v/C8ZWxAiJqvmAcatSsUF+qfIlFDyt37NEMSDoJrU+9TvBFKo11NQK8f3LjY1eUjkZVFN5XeT0z6ICJSpqS+zv3NIH9X1jBdY645Zyty9/yIK6n2hdoR1x+Iuj98OymthlHx5FMiFJ4Yb6P7FPPEjUV8QFl41NRr1YPSLMjHBIbIe5aA24vAkIgrVMVTNKCdDHGZYY+66JLSyHDrn80IPh6j3fe/wqqNJGLDSFg4yKjTTkWkRssD6TGK4jBNaZjJKOf5f9WIo9yy5gqetY+wIDAQAB';

/** The DKIM DNS TXT record a verifier (mailauth / our verifyDkim) resolves. */
export const GOLDEN_DKIM_TXT_RECORD = `v=DKIM1; k=rsa; p=${GOLDEN_DKIM_PUBLIC_P}`;
