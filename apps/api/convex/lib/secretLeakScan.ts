/**
 * Deterministic credential-leak / sensitive-data detection for outbound content.
 * A planted or hallucinated API key, private key, one-time passcode, or account-
 * recovery link in an auto-sent reply would leak a secret past the org boundary
 * with no human in the loop, so the auto-send gate scans the draft for known
 * fingerprints and fails closed (downgrades to human review) on a hit — the same
 * posture as the outbound injection check.
 *
 * Two families are matched:
 *   - CREDENTIALS — API keys / tokens / private keys (self-contained shapes).
 *   - SENSITIVE DELIVERY — OTP / 2FA / verification codes and account-recovery
 *     / password-reset / magic-link URLs. An autonomous reply that hands out a
 *     one-time code or a reset link is a phishing / exfiltration vector; these
 *     are contextual patterns (a keyword anchored near a code, or a reset-token
 *     URL) so ordinary prose with a bare number does not trip them.
 *
 * Pattern-only and cheap; a false positive just routes a message to human
 * review (never blocks or drops it), so the patterns lean inclusive.
 */

type SecretPattern = { kind: string; re: RegExp };

const SECRET_PATTERNS: SecretPattern[] = [
	{ kind: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
	{ kind: 'openai_key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
	{ kind: 'stripe_key', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/ },
	{ kind: 'github_pat', re: /\bghp_[A-Za-z0-9]{36}\b/ },
	{ kind: 'github_fine_grained_pat', re: /\bgithub_pat_[A-Za-z0-9_]{40,}/ },
	{ kind: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
	{ kind: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
	{ kind: 'aws_access_key_id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{ kind: 'sendgrid_key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
	{ kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
	{ kind: 'private_key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
	// One-time passcode / 2FA / verification code: a code phrase anchored within
	// a short window of a 4–10 digit code, in either order. The keyword anchor
	// keeps ordinary prose ("order 1234567 ships Tuesday") from tripping it.
	{
		kind: 'otp_code',
		re: /\b(?:one[-\s]?time\s+(?:pass(?:word|code)|code|pin)|verification\s+code|security\s+code|2fa\s+code|otp)\b[\s\S]{0,40}?\b\d{4,10}\b/i,
	},
	{
		kind: 'otp_code',
		re: /\b\d{4,10}\b[\s\S]{0,40}?\bis\s+your\s+(?:one[-\s]?time|verification|security|login|2fa|otp)\b/i,
	},
	// Account-recovery / password-reset / magic-link URL, or any URL carrying a
	// reset/verification/one-time token query parameter.
	{
		kind: 'recovery_link',
		re: /https?:\/\/[^\s"'<>]*(?:reset[-_]?password|password[-_]?reset|forgot[-_]?password|account[-_]?recovery|recover[-_]?account|verify[-_]?(?:email|account)|confirm[-_]?email|magic[-_]?link|[?&](?:reset(?:_token)?|otp|verification_?code|magic_?token|confirmation_?token)=)[^\s"'<>]*/i,
	},
];

export interface SecretLeakResult {
	detected: boolean;
	kind?: string;
}

/** Scan text for a known credential / private-key fingerprint. */
export function detectSecretLeak(text: string): SecretLeakResult {
	for (const { kind, re } of SECRET_PATTERNS) {
		if (re.test(text)) return { detected: true, kind };
	}
	return { detected: false };
}
