import { getOptional } from './env';
import { logError } from './runtimeLog';
import { extractDomainOrNull } from '@owlat/shared';

/**
 * Strip CR/LF from a header-context value (subject, from) before it crosses
 * the wire to the MTA `/send` endpoint. RFC 5322 §2.2: a bare CR/LF in a
 * header value would let a hostile substitution append extra headers
 * (e.g. `Bcc:`). Producer-side defense-in-depth — we never rely on the
 * transport to be the only CRLF guard. Mirrors `mail/rfc822.ts` `escapeHeader`.
 */
function stripHeaderCrlf(value: string): string {
	return value.replace(/[\r\n]+/g, ' ');
}

/**
 * Send an email through the instance's own MTA — the single transport every
 * system / auth email uses (password reset, invitation, account-deletion
 * confirmation, …). Throws if the MTA is not configured.
 *
 * Runtime-agnostic (fetch + crypto only), so it works from both the default
 * Convex runtime and `'use node'` actions. This is the one place the MTA
 * `/send` contract lives, so all system emails share one transport and one
 * configuration rather than some going through Resend and others through MTA.
 */
export async function sendViaInstanceMta(params: {
	to: string;
	from: string;
	subject: string;
	html: string;
}): Promise<void> {
	const mtaApiUrl = getOptional('MTA_API_URL');
	const mtaApiKey = getOptional('MTA_API_KEY');

	if (!mtaApiUrl || !mtaApiKey) {
		logError(`[Instance Email] MTA not configured. Would have sent to ${params.to}: ${params.subject}`);
		throw new Error('Email service is not configured. MTA_API_URL and MTA_API_KEY are required.');
	}

	// Neutralize CR/LF in the header-context fields at the producer before they
	// are serialized into the /send body — header injection (RFC 5322 §2.2)
	// must be stopped here, not left to the transport.
	const from = stripHeaderCrlf(params.from);
	const subject = stripHeaderCrlf(params.subject);

	const fromDomain = extractDomainOrNull(from) ?? '';

	const response = await fetch(`${mtaApiUrl.replace(/\/$/, '')}/send`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${mtaApiKey}`,
		},
		body: JSON.stringify({
			messageId: crypto.randomUUID(),
			to: params.to,
			from,
			subject,
			html: params.html,
			// RFC 3834 §5: every system/auth/DOI mail this transport sends
			// (password reset, invitation, account-deletion, double opt-in,
			// email-change) is machine-generated, so it must carry
			// Auto-Submitted: auto-generated. This lets receiving auto-responders
			// (incl. another Owlat instance via isAutomatedMail) suppress replies
			// and stops mail loops.
			headers: { 'Auto-Submitted': 'auto-generated' },
			ipPool: 'transactional',
			dkimDomain: fromDomain,
		}),
		signal: AbortSignal.timeout(30_000),
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => 'Unknown error');
		logError('[Instance Email] MTA send failed:', errorText);
		throw new Error('Failed to send email. Please try again.');
	}

	const result = (await response.json()) as { success: boolean; error?: string };
	if (!result.success) {
		logError('[Instance Email] MTA returned error:', result.error);
		throw new Error('Failed to send email. Please try again.');
	}
}
