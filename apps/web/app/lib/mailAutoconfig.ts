/**
 * The network half of mail autodiscover (`utils/mailAutodiscover.ts`): reading
 * a Thunderbird autoconfig document. Fail-soft like its caller, so every error
 * is a `null`, never a throw.
 */
import type { MailPreset } from '~/utils/mailAutodiscover';

/** Autoconfig `socketType` values that mean "implicit TLS". */
function isSecureSocket(socketType: string | null): boolean {
	return socketType?.toUpperCase() === 'SSL';
}

/**
 * Parse the `<incomingServer type="imap">` / `<outgoingServer type="smtp">`
 * blocks of a Thunderbird autoconfig XML document into a `MailPreset`. Returns
 * `null` when either server block or a required field is missing.
 */
export function parseAutoconfigXml(xml: string): MailPreset | null {
	try {
		const doc = new DOMParser().parseFromString(xml, 'application/xml');
		if (doc.querySelector('parsererror')) return null;

		const incoming = Array.from(doc.querySelectorAll('incomingServer')).find(
			(el) => el.getAttribute('type')?.toLowerCase() === 'imap'
		);
		const outgoing = doc.querySelector('outgoingServer[type="smtp"]');
		if (!incoming || !outgoing) return null;

		const text = (parent: Element, tag: string): string | null =>
			parent.querySelector(tag)?.textContent?.trim() ?? null;

		const imapHost = text(incoming, 'hostname');
		const imapPort = Number(text(incoming, 'port'));
		const smtpHost = text(outgoing, 'hostname');
		const smtpPort = Number(text(outgoing, 'port'));
		if (!imapHost || !smtpHost || !Number.isFinite(imapPort) || !Number.isFinite(smtpPort)) {
			return null;
		}

		return {
			imapHost,
			imapPort,
			isImapSecure: isSecureSocket(text(incoming, 'socketType')),
			smtpHost,
			smtpPort,
			isSmtpSecure: isSecureSocket(text(outgoing, 'socketType')),
		};
	} catch {
		return null;
	}
}

/** Fetch a URL and return its text body, or `null` on any error / non-2xx / timeout. */
export async function fetchTextSoft(url: string, timeoutMs: number): Promise<string | null> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(url, { signal: controller.signal });
			if (!response.ok) return null;
			return await response.text();
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return null;
	}
}
