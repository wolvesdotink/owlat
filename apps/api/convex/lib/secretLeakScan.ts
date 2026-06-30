/**
 * Deterministic credential-leak detection for outbound content. A planted or
 * hallucinated API key / private key in an auto-sent reply would leak a secret
 * past the org boundary with no human in the loop, so the auto-send gate scans
 * the draft for known credential fingerprints and fails closed (downgrades to
 * human review) on a hit — the same posture as the outbound injection check.
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
