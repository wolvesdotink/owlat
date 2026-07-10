/**
 * Code-agent appropriateness guard.
 *
 * The inbound `security_scan` step (agent/steps/security_scan) defends the
 * EMAIL ASSISTANT: it looks for prompt-injection aimed at manipulating the
 * reply drafter. That guard says nothing about instructions smuggled to a
 * CODE agent — "add a backdoor", "leak the environment secrets", "force-push
 * to main", "pipe this script into a shell". A feature-request email whose
 * body is handed to an autonomous coding agent is a distinct, higher-stakes
 * attack surface, so it gets its own check here.
 *
 * This is deliberately a SEPARATE, deterministic gate rather than a reuse of
 * the email guard: the two care about different threats and must be able to
 * evolve independently. We DO reuse the pure prompt-injection primitives
 * (`detectInjection`, `detectSmuggling`, `stripHiddenContent`) from the
 * security-scan patterns module — a classic "ignore previous instructions"
 * override is dangerous to a code agent too — and layer code-agent-specific
 * malicious-instruction patterns on top.
 *
 * Pure + deterministic (no ctx, no I/O, never throws) so it can run inside the
 * `createFromInbound` internal mutation before any task is queued, and be unit
 * tested in isolation.
 */

import {
	detectInjection,
	detectSmuggling,
	stripHiddenContent,
} from '../agent/steps/security_scan/patterns';

/**
 * Instructions that would direct a coding agent to do something destructive,
 * exfiltrating, or otherwise unauthorized. These are matched against the
 * hidden-content-stripped subject + body of an inbound feature request.
 *
 * Kept intentionally narrow (known attack shapes) so ordinary feature requests
 * — "add a dark-mode toggle", "the export button 404s" — never trip them.
 */
const CODE_AGENT_MALICIOUS_PATTERNS: readonly RegExp[] = [
	// Destructive filesystem / VCS / database operations.
	/\brm\s+-rf\b/i,
	/\bgit\s+push\s+(--force|-f)\b/i,
	/force[-\s]?push\s+(to\s+)?(main|master|trunk)\b/i,
	/\bdrop\s+(table|database|schema)\b/i,
	/\btruncate\s+table\b/i,
	// Secret / credential exfiltration.
	/\b(exfiltrate|leak|steal|dump|upload|send|post|email)\b[\s\S]{0,40}\b(env|environment|secret|secrets|credential|credentials|api[-\s]?key|token|password|\.env|private\s+key)\b/i,
	/\bprint\b[\s\S]{0,30}\b(env|environment)\s+(variable|var)s?\b/i,
	/\bprocess\.env\b/i,
	/\bprintenv\b/i,
	/\bcat\b[\s\S]{0,20}(\.env|id_rsa|\.ssh|\.pem)\b/i,
	// Backdoors / auth bypass / privilege escalation.
	/\b(add|insert|install|plant)\b[\s\S]{0,20}\bbackdoor\b/i,
	/\b(disable|bypass|remove|skip)\b[\s\S]{0,30}\b(auth|authentication|authorization|permission|access\s+control|security\s+check)\b/i,
	/\b(reverse|bind)\s+shell\b/i,
	/\bhard[-\s]?code\b[\s\S]{0,20}\b(password|credential|token|api[-\s]?key)\b/i,
	/\b(create|add|grant)\b[\s\S]{0,20}\badmin\b[\s\S]{0,20}\b(user|account|access)\b/i,
	// Remote code execution: pipe a fetched script straight into a shell.
	/\b(curl|wget)\b[\s\S]{0,80}\|\s*(sudo\s+)?(sh|bash|zsh)\b/i,
	// CI / test tampering.
	/\b(disable|delete|remove|skip|bypass)\b[\s\S]{0,30}\b(ci|test|tests|workflow|github\s+action)\b/i,
	/\.github\/workflows\b/i,
];

export interface CodeAgentSafetyResult {
	/** True when the request may be turned into a code-work task. */
	safe: boolean;
	/** Populated only when `safe` is false: which check rejected it. */
	reason?: string;
}

interface CodeAgentSafetyInput {
	subject: string;
	textBody?: string | undefined;
	htmlBody?: string | undefined;
}

/**
 * Decide whether an inbound feature request is safe to hand to the coding
 * agent. Rejects prompt-injection overrides, hidden HTML instruction smuggling,
 * and code-agent-specific malicious instructions. Fails CLOSED: anything that
 * matches a known-dangerous shape is rejected (no task is created), but the
 * message still processes as normal inbound mail.
 */
export function checkCodeAgentSafety(input: CodeAgentSafetyInput): CodeAgentSafetyResult {
	// Strip content hidden from a human reader (HTML comments, invisible spans,
	// zero-width chars) so a smuggled instruction can't slip past the pattern
	// matches by hiding in markup the coding agent would still read.
	const subject = stripHiddenContent(input.subject);
	const body = stripHiddenContent(input.textBody ?? input.htmlBody ?? '');
	const combined = `${subject}\n\n${body}`;

	// Hidden HTML instruction smuggling in the raw markup.
	const smuggling = detectSmuggling(input.htmlBody);
	if (smuggling.detected) {
		return {
			safe: false,
			reason: 'The request hides instructions inside markup a person cannot see.',
		};
	}

	// Prompt-injection override ("ignore previous instructions", role
	// impersonation, delimiter attacks) — dangerous to a code agent too.
	const injection = detectInjection(combined);
	if (injection.detected) {
		return {
			safe: false,
			reason: 'The request tries to override the coding agent with new instructions.',
		};
	}

	// Code-agent-specific destructive / exfiltrating / backdoor instructions.
	for (const pattern of CODE_AGENT_MALICIOUS_PATTERNS) {
		if (pattern.test(combined)) {
			return {
				safe: false,
				reason: 'The request asks the coding agent to run destructive or unauthorized changes.',
			};
		}
	}

	return { safe: true };
}
