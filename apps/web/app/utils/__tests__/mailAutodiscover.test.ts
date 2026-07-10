import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	MAIL_PROVIDERS,
	appPasswordHelpForEmail,
	autodiscover,
	domainOfEmail,
	presetForEmail,
	providerById,
	providerPreset,
	resolveMailPreset,
} from '../mailAutodiscover';

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
			vi.fn(async () => ({ ok: true, text: async () => autoconfigXml() }))
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
			}))
		);
		const p = await autodiscover('user@example.net');
		expect(p?.isImapSecure).toBe(false);
		expect(p?.isSmtpSecure).toBe(false);
	});

	it('returns null when the XML is missing a server block', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, text: async () => autoconfigXml({ dropSmtp: true }) }))
		);
		expect(await autodiscover('user@example.net')).toBeNull();
	});

	it('returns null on a network error (fail-soft)', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('network down');
			})
		);
		expect(await autodiscover('user@example.net')).toBeNull();
	});

	it('returns null on non-2xx responses', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, text: async () => '' }))
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
			vi.fn(async () => ({ ok: true, text: async () => autoconfigXml() }))
		);
		const p = await resolveMailPreset('a@example.net');
		expect(p?.imapHost).toBe('imap.example.net');
	});
});

describe('appPasswordHelpForEmail', () => {
	it('maps known providers to their deep-linked app-password page', () => {
		expect(appPasswordHelpForEmail('me@gmail.com')?.url).toBe(
			'https://myaccount.google.com/apppasswords'
		);
		expect(appPasswordHelpForEmail('me@googlemail.com')?.provider).toBe('Gmail');
		expect(appPasswordHelpForEmail('me@outlook.com')?.url).toBe(
			'https://account.live.com/proofs/AppPassword'
		);
		expect(appPasswordHelpForEmail('me@hotmail.com')?.provider).toBe('Outlook');
		expect(appPasswordHelpForEmail('me@icloud.com')?.url).toBe(
			'https://appleid.apple.com/account/manage'
		);
		expect(appPasswordHelpForEmail('me@me.com')?.provider).toBe('iCloud');
		expect(appPasswordHelpForEmail('me@yahoo.com')?.url).toBe(
			'https://login.yahoo.com/account/security/app-passwords'
		);
	});

	it('is case-insensitive on the domain', () => {
		expect(appPasswordHelpForEmail('Me@GMAIL.com')?.provider).toBe('Gmail');
	});

	it('always includes a non-empty steps line for known providers', () => {
		expect(appPasswordHelpForEmail('me@gmail.com')?.steps.length).toBeGreaterThan(0);
	});

	it('returns null for unknown / self-hosted providers', () => {
		expect(appPasswordHelpForEmail('me@fastmail.com')).toBeNull();
		expect(appPasswordHelpForEmail('me@example.net')).toBeNull();
	});

	it('returns null for a malformed address', () => {
		expect(appPasswordHelpForEmail('not-an-email')).toBeNull();
		expect(appPasswordHelpForEmail('')).toBeNull();
	});
});

describe('MAIL_PROVIDERS (import-wizard provider list)', () => {
	it('maps each guided provider to the right IMAP/SMTP host + port', () => {
		const expected: Record<
			string,
			{ imapHost: string; imapPort: number; smtpHost: string; smtpPort: number }
		> = {
			gmail: {
				imapHost: 'imap.gmail.com',
				imapPort: 993,
				smtpHost: 'smtp.gmail.com',
				smtpPort: 465,
			},
			outlook: {
				imapHost: 'outlook.office365.com',
				imapPort: 993,
				smtpHost: 'smtp-mail.outlook.com',
				smtpPort: 587,
			},
			fastmail: {
				imapHost: 'imap.fastmail.com',
				imapPort: 993,
				smtpHost: 'smtp.fastmail.com',
				smtpPort: 465,
			},
			icloud: {
				imapHost: 'imap.mail.me.com',
				imapPort: 993,
				smtpHost: 'smtp.mail.me.com',
				smtpPort: 587,
			},
			yahoo: {
				imapHost: 'imap.mail.yahoo.com',
				imapPort: 993,
				smtpHost: 'smtp.mail.yahoo.com',
				smtpPort: 465,
			},
		};
		for (const [id, want] of Object.entries(expected)) {
			const preset = providerPreset(id);
			expect(preset, id).not.toBeNull();
			expect(preset?.imapHost, id).toBe(want.imapHost);
			expect(preset?.imapPort, id).toBe(want.imapPort);
			expect(preset?.smtpHost, id).toBe(want.smtpHost);
			expect(preset?.smtpPort, id).toBe(want.smtpPort);
		}
	});

	it('has no preset for the generic IMAP provider (manual entry)', () => {
		const imap = providerById('imap');
		expect(imap?.manualServer).toBe(true);
		expect(imap?.preset).toBeNull();
		expect(providerPreset('imap')).toBeNull();
	});

	it('every guided provider carries a preset and is not marked manual', () => {
		for (const p of MAIL_PROVIDERS) {
			if (p.id === 'imap') continue;
			expect(p.preset, p.id).not.toBeNull();
			expect(p.manualServer, p.id).toBe(false);
		}
	});

	it('provider presets agree with the domain autodiscover table', () => {
		// The picker and the type-ahead autodiscover must never disagree.
		expect(providerPreset('gmail')).toEqual(presetForEmail('me@gmail.com'));
		expect(providerPreset('outlook')).toEqual(presetForEmail('me@outlook.com'));
		expect(providerPreset('fastmail')).toEqual(presetForEmail('me@fastmail.com'));
		expect(providerPreset('icloud')).toEqual(presetForEmail('me@icloud.com'));
	});

	it('surfaces app-password guidance for providers that require one', () => {
		expect(providerById('gmail')?.appPassword?.provider).toBe('Gmail');
		expect(providerById('fastmail')?.appPassword?.provider).toBe('Fastmail');
		expect(providerById('imap')?.appPassword).toBeNull();
	});

	it('returns undefined for an unknown provider id', () => {
		expect(providerById('nope')).toBeUndefined();
		expect(providerPreset('nope')).toBeNull();
	});
});
