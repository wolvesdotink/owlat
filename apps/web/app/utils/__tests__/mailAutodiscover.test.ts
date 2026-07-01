import { describe, it, expect, vi, afterEach } from 'vitest';
import { autodiscover, domainOfEmail, presetForEmail, resolveMailPreset } from '../mailAutodiscover';

/** Minimal Thunderbird autoconfig document for a made-up provider. */
function autoconfigXml(opts?: {
	imapSocket?: string;
	smtpSocket?: string;
	dropSmtp?: boolean;
}): string {
	const smtp = opts?.dropSmtp
		? ''
		: `<outgoingServer type="smtp">
				<hostname>smtp.example.net</hostname>
				<port>465</port>
				<socketType>${opts?.smtpSocket ?? 'SSL'}</socketType>
			</outgoingServer>`;
	return `<?xml version="1.0"?>
		<clientConfig version="1.1">
			<emailProvider id="example.net">
				<incomingServer type="imap">
					<hostname>imap.example.net</hostname>
					<port>993</port>
					<socketType>${opts?.imapSocket ?? 'SSL'}</socketType>
				</incomingServer>
				${smtp}
			</emailProvider>
		</clientConfig>`;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('domainOfEmail', () => {
	it('extracts and lower-cases the domain', () => {
		expect(domainOfEmail('Jane@Example.COM')).toBe('example.com');
	});
	it('returns null for malformed addresses', () => {
		expect(domainOfEmail('nope')).toBeNull();
		expect(domainOfEmail('a@')).toBeNull();
		expect(domainOfEmail('@b.com')).toBeNull();
		expect(domainOfEmail('a@localhost')).toBeNull();
	});
});

describe('presetForEmail', () => {
	it('maps Gmail domains', () => {
		expect(presetForEmail('a@gmail.com')?.imapHost).toBe('imap.gmail.com');
		expect(presetForEmail('a@googlemail.com')?.smtpHost).toBe('smtp.gmail.com');
	});
	it('maps Outlook domains', () => {
		for (const d of ['outlook.com', 'hotmail.com', 'live.com']) {
			const p = presetForEmail(`a@${d}`);
			expect(p?.imapHost).toBe('outlook.office365.com');
			expect(p?.smtpPort).toBe(587);
			expect(p?.isSmtpSecure).toBe(false);
		}
	});
	it('maps iCloud domains', () => {
		for (const d of ['icloud.com', 'me.com', 'mac.com']) {
			expect(presetForEmail(`a@${d}`)?.imapHost).toBe('imap.mail.me.com');
		}
	});
	it('maps Fastmail domains', () => {
		expect(presetForEmail('a@fastmail.com')?.imapHost).toBe('imap.fastmail.com');
		expect(presetForEmail('a@fastmail.fm')?.smtpHost).toBe('smtp.fastmail.com');
	});
	it('returns null for unknown or malformed domains', () => {
		expect(presetForEmail('a@example.net')).toBeNull();
		expect(presetForEmail('garbage')).toBeNull();
	});
});

describe('autodiscover', () => {
	it('parses a valid autoconfig XML response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, text: async () => autoconfigXml() })),
		);
		const p = await autodiscover('user@example.net');
		expect(p).toEqual({
			imapHost: 'imap.example.net',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.example.net',
			smtpPort: 465,
			isSmtpSecure: true,
		});
	});

	it('treats STARTTLS/plain socketType as not-secure', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: true,
				text: async () => autoconfigXml({ imapSocket: 'STARTTLS', smtpSocket: 'STARTTLS' }),
			})),
		);
		const p = await autodiscover('user@example.net');
		expect(p?.isImapSecure).toBe(false);
		expect(p?.isSmtpSecure).toBe(false);
	});

	it('returns null when the XML is missing a server block', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, text: async () => autoconfigXml({ dropSmtp: true }) })),
		);
		expect(await autodiscover('user@example.net')).toBeNull();
	});

	it('returns null on a network error (fail-soft)', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('network down');
			}),
		);
		expect(await autodiscover('user@example.net')).toBeNull();
	});

	it('returns null on non-2xx responses', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, text: async () => '' })),
		);
		expect(await autodiscover('user@example.net')).toBeNull();
	});

	it('returns null for a malformed email without hitting the network', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		expect(await autodiscover('garbage')).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe('resolveMailPreset', () => {
	it('prefers the curated table and does not hit the network for known domains', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const p = await resolveMailPreset('a@gmail.com');
		expect(p?.imapHost).toBe('imap.gmail.com');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('falls back to autodiscover for unknown domains', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, text: async () => autoconfigXml() })),
		);
		const p = await resolveMailPreset('a@example.net');
		expect(p?.imapHost).toBe('imap.example.net');
	});
});
