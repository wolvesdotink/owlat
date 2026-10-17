import { describe, expect, it } from 'vitest';
import { detectExactWording } from '../exactWordingDetector';

const kinds = (text: string, subject?: string) =>
	detectExactWording({ text, ...(subject !== undefined ? { subject } : {}) });

describe('detectExactWording: payment details', () => {
	it.each([
		['Please note our new bank details for all future payments.'],
		['Our banking details have changed as of 1 March.'],
		['Wire instructions are attached; please confirm receipt.'],
		['Account number: 12345678, sort code 20-00-00.'],
		['BIC: COBADEFFXXX'],
		['Bitte beachte unsere neue Bankverbindung ab dem 1. März.'],
		['Unsere Bankverbindung hat sich geändert.'],
		['Anbei die Zahlungsanweisung für die Rechnung.'],
		['Kontonummer: 1234567890'],
		['Bitte überweise den Betrag bis Freitag.'],
	])('flags %s', (text) => {
		expect(kinds(text)).toContain('payment_details');
	});

	it('flags a valid IBAN, spaced or compact, and ignores one with a bad checksum', () => {
		expect(kinds('Pay to DE89 3704 0044 0532 0130 00 please.')).toContain('payment_details');
		expect(kinds('IBAN GB82WEST12345698765432')).toContain('payment_details');
		expect(kinds('Reference DE88 3704 0044 0532 0130 00')).toEqual([]);
		expect(kinds('Order code AB12CDEFGHIJKLMNOP shipped.')).toEqual([]);
	});
});

describe('detectExactWording: legal and contractual notices', () => {
	it.each([
		['This is a notice of termination of your lease.'],
		['Termination of your contract takes effect on 30 June.'],
		['We are making changes to our terms of service.'],
		['Updated privacy policy: what changes for you'],
		['FINAL NOTICE before we pass this to a debt collection agency'],
		['You are required to attend the court hearing on 4 May.'],
		['Bestätigung deiner Kündigung'],
		['Hiermit kündigen wir den Vertrag fristgerecht.'],
		['Änderungen unserer Nutzungsbedingungen ab 1. Juli'],
		['Letzte Mahnung: offener Betrag'],
		['Der Termin beim Amtsgericht ist am Montag.'],
	])('flags %s', (text) => {
		expect(kinds(text)).toContain('legal_notice');
	});

	it('reads the subject too', () => {
		expect(kinds('Hello,\nsee below.', 'Kündigungsbestätigung Vertrag 1234')).toContain(
			'legal_notice'
		);
	});
});

describe('detectExactWording: invoices that carry payment details', () => {
	it.each([
		['Your invoice #2041: amount due 120.00 EUR, due date 12 May.'],
		['Rechnung 2041 – zahlbar bis 12.05., Rechnungsbetrag 120,00 €'],
		['Invoice attached. IBAN DE89370400440532013000'],
	])('flags %s', (text) => {
		expect(kinds(text)).toContain('invoice_payment');
	});

	it('does not flag an invoice without payment details', () => {
		expect(kinds('Your invoice is ready to download in your account.')).toEqual([]);
		expect(kinds('Deine Rechnung ist jetzt im Kundenkonto verfügbar.')).toEqual([]);
	});
});

describe('detectExactWording: negatives', () => {
	it.each([
		['Your package has shipped and will arrive on Tuesday.'],
		['Weekly digest: 5 new posts in your community.'],
		['Someone liked your photo.'],
		['Dein Paket wurde zugestellt.'],
		['Neues Gericht der Woche: Linsensuppe'],
		['Herzliche Einladung zu unserem Sommerfest!'],
		['Your account settings were saved.'],
		['Thanks for your order! We will let you know when it ships.'],
		['Meeting notes from Tuesday, including the new terms we discussed with Anna.'],
	])('does not flag %s', (text) => {
		expect(kinds(text)).toEqual([]);
	});

	it('ignores whole-word matches inside longer words', () => {
		expect(kinds('Unkündigungsvertrag')).toEqual([]);
		expect(kinds('Bitteüberweisen')).toEqual([]);
	});

	it('stays fast on long adversarial input', () => {
		const text = `${'A1'.repeat(50_000)} ${'DE00 '.repeat(20_000)} ${'notice of '.repeat(5000)}`;
		const start = performance.now();
		detectExactWording({ text });
		expect(performance.now() - start).toBeLessThan(500);
	});
});
