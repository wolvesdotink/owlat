import { describe, it, expect } from 'vitest';
import {
	MAIL_PROVIDERS,
	providerForImapHost,
	domainOfEmail,
	presetForEmail,
	providerById,
	providerPreset,
} from '../mailAutodiscover';

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
	it('maps Yahoo domains', () => {
		for (const d of ['yahoo.com', 'ymail.com', 'yahoo.co.uk']) {
			const p = presetForEmail(`a@${d}`);
			expect(p?.imapHost, d).toBe('imap.mail.yahoo.com');
			expect(p?.smtpHost, d).toBe('smtp.mail.yahoo.com');
		}
	});
	it('returns null for unknown or malformed domains', () => {
		expect(presetForEmail('a@example.net')).toBeNull();
		expect(presetForEmail('garbage')).toBeNull();
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
		expect(providerPreset('yahoo')).toEqual(presetForEmail('me@yahoo.com'));
	});

	it('surfaces app-password guidance for providers that require one', () => {
		expect(providerById('gmail')?.appPassword?.provider).toBe('Gmail');
		expect(providerById('fastmail')?.appPassword?.provider).toBe('Fastmail');
		expect(providerById('imap')?.appPassword).toBeNull();
	});

	it('offers provider sign-in for Gmail and Outlook only, and keeps their app-password fallback', () => {
		// The connect form reads this to decide whether to offer a sign-in button
		// at all; every other provider must stay on the password path, and both
		// keep their app-password guidance for instances with no OAuth app.
		expect(providerById('gmail')?.oauth).toEqual({ provider: 'google' });
		expect(providerById('gmail')?.appPassword?.provider).toBe('Gmail');
		expect(providerById('outlook')?.oauth).toEqual({ provider: 'microsoft' });
		expect(providerById('outlook')?.appPassword).not.toBeNull();
		for (const p of MAIL_PROVIDERS) {
			if (p.id === 'gmail' || p.id === 'outlook') continue;
			expect(p.oauth, p.id).toBeNull();
		}
	});

	it('matches a connected account back to its provider by IMAP host', () => {
		// How an EDIT/RECONNECT form knows a stored account is Gmail: the account
		// row remembers servers, not which picker card created it.
		expect(providerForImapHost('imap.gmail.com').id).toBe('gmail');
		expect(providerForImapHost('IMAP.GMAIL.COM').id).toBe('gmail');
		expect(providerForImapHost('imap.fastmail.com').id).toBe('fastmail');
		expect(providerForImapHost('mail.acme.test').id).toBe('imap');
		expect(providerForImapHost(null).id).toBe('imap');
	});

	it('returns undefined for an unknown provider id', () => {
		expect(providerById('nope')).toBeUndefined();
		expect(providerPreset('nope')).toBeNull();
	});
});
