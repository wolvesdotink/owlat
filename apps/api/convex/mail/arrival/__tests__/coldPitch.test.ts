/**
 * #1381, the pure parts: who is asked the cold-pitch question, the R2 prompt
 * that asks it, the digest group it lands in, and the labelled sample's
 * release gate.
 */

import { describe, expect, it } from 'vitest';
import {
	isColdPitchCandidate,
	isOwnerInThread,
	isSameCompanyDomain,
	type ColdPitchEvidence,
} from '../coldPitch';
import { hasOwnerSenderChoice, isColdPitchStanding } from '../projection';
import { COLD_PITCH_QUESTION, isColdPitchAnswer, r2QuestionsPrompt } from '../r2';
import { digestKindOf, selectDigest, type DigestCandidate } from '../../digest/select';
import { digestBlocks } from '../../digest/emailBlocks';
import { dailyBriefEmailCopy } from '../../../lib/systemEmailCopy';
import { COLD_PITCH_SAMPLE } from '../__eval__/coldPitchSample';
import {
	coldPitchEvalPrompt,
	runColdPitchEval,
	scoreColdPitchRun,
} from '../__eval__/coldPitchEval';
import type { Id } from '../../../_generated/dataModel';

const stranger: ColdPitchEvidence = {
	isFlagOn: true,
	isPersonalMailbox: true,
	hasArrivalRecord: true,
	isFromOwner: false,
	isInAddressBook: false,
	hasOwnerSenderChoice: false,
	hasCategoryOverride: false,
	isOwnerInThread: false,
	senderDomain: 'growthleads.example',
	ownDomains: ['owlat.test'],
};

describe('isColdPitchCandidate: cheap evidence first', () => {
	it('asks about a first-time sender with no relationship', () => {
		expect(isColdPitchCandidate(stranger)).toBe(true);
	});

	it.each([
		['the flag is off', { isFlagOn: false }],
		['a shared mailbox', { isPersonalMailbox: false }],
		['no arrival record (import, owner copy)', { hasArrivalRecord: false }],
		['the owner sent it', { isFromOwner: true }],
		['a contact: written to, accepted, VIP or in the address book', { isInAddressBook: true }],
		['a sender status or placement the owner chose', { hasOwnerSenderChoice: true }],
		['a category override for the sender', { hasCategoryOverride: true }],
		['the owner took part in the thread', { isOwnerInThread: true }],
		['a colleague on the company domain', { senderDomain: 'owlat.test' }],
	] as const)('skips it when %s', (_, change) => {
		expect(isColdPitchCandidate({ ...stranger, ...change })).toBe(false);
	});

	it('a shared public mail provider is no relationship', () => {
		expect(isSameCompanyDomain('gmail.com', ['gmail.com'])).toBe(false);
		expect(
			isColdPitchCandidate({ ...stranger, senderDomain: 'gmail.com', ownDomains: ['gmail.com'] })
		).toBe(true);
		expect(isSameCompanyDomain('', [''])).toBe(false);
	});

	it('reads owner choices from the sender profile', () => {
		expect(hasOwnerSenderChoice(null)).toBe(false);
		expect(hasOwnerSenderChoice({ statusSource: 'default' })).toBe(false);
		expect(hasOwnerSenderChoice({ statusSource: 'learned' })).toBe(false);
		expect(hasOwnerSenderChoice({ statusSource: 'user' })).toBe(true);
		expect(hasOwnerSenderChoice({ statusSource: 'suggestion' })).toBe(true);
		expect(hasOwnerSenderChoice({ statusSource: 'default', placementOverride: 'today' })).toBe(
			true
		);
	});

	it('a choice the owner makes about the sender later voids a verdict', () => {
		expect(isColdPitchStanding({ coldPitchAt: 1 }, null)).toBe(true);
		expect(isColdPitchStanding({ coldPitchAt: 1 }, { statusSource: 'learned' })).toBe(true);
		expect(isColdPitchStanding({ coldPitchAt: 1 }, { statusSource: 'user' })).toBe(false);
		expect(isColdPitchStanding({}, null)).toBe(false);
	});

	it('reads owner participation from the thread', () => {
		expect(isOwnerInThread({ folderRoles: ['inbox'] })).toBe(false);
		expect(isOwnerInThread({ folderRoles: ['inbox', 'sent'] })).toBe(true);
		expect(
			isOwnerInThread({
				folderRoles: ['inbox'],
				latestReply: { messageId: 'm' as Id<'mailMessages'>, at: 1 },
			})
		).toBe(true);
	});
});

describe('the R2 prompt', () => {
	const input = {
		subject: 'Quick question',
		segments: [{ id: 's0', kind: 'fresh', text: 'Open to a call?', start: 0, end: 15 }],
	};

	it('asks the cold-pitch question with no rule questions, the email fenced once', () => {
		const prompt = r2QuestionsPrompt([], input, { isColdPitchAsked: true });
		expect(prompt).toContain(COLD_PITCH_QUESTION);
		expect(prompt).toContain('answer coldPitch');
		expect(prompt).not.toContain('numbered question');
		expect(prompt.match(/<\/untrusted_email_content>/g)).toHaveLength(1);
	});

	it('leaves a rule-questions prompt unchanged when the question is not asked', () => {
		const questions = [
			{ filterId: 'f' as Id<'mailFilters'>, revision: 0, question: 'Is it about a parcel?' },
		];
		const prompt = r2QuestionsPrompt(questions, input);
		expect(prompt).toContain('1. Is it about a parcel?');
		expect(prompt).not.toContain('coldPitch');
		expect(r2QuestionsPrompt(questions, input, { isColdPitchAsked: true })).toContain(
			'1. Is it about a parcel?'
		);
	});

	it('only a yes is a cold pitch', () => {
		expect(isColdPitchAnswer('yes')).toBe(true);
		expect(isColdPitchAnswer('no')).toBe(false);
		expect(isColdPitchAnswer('unknown')).toBe(false);
		expect(isColdPitchAnswer(undefined)).toBe(false);
	});
});

describe('the digest group', () => {
	it('files a cold pitch under Cold outreach whatever its category', () => {
		expect(digestKindOf('promotion', true)).toBe('cold_outreach');
		expect(digestKindOf('other', true)).toBe('cold_outreach');
		expect(digestKindOf('promotion')).toBe('promotion');
		expect(digestKindOf('other')).toBe('updates');
	});

	it('names the group in the Daily Brief email, in both locales', () => {
		const digest = {
			groups: [
				{
					kind: 'cold_outreach' as const,
					lines: [
						{
							messageId: 'm1' as Id<'mailMessages'>,
							sender: 'Jordan Miles',
							subject: 'Quick question about your website',
							spans: [],
							path: '/dashboard/postbox/inbox/m1',
						},
					],
					more: 0,
				},
			],
			overflowLabel: 'exact' as const,
		};
		const html = (locale: 'en' | 'de') =>
			digestBlocks({ digest, copy: dailyBriefEmailCopy(locale), baseUrl: 'https://owlat.example' })
				.map((block) => (block.content as { html: string }).html)
				.join('\n');
		expect(html('en')).toContain('<strong>Cold outreach</strong>');
		expect(html('de')).toContain('<strong>Kaltakquise</strong>');
	});

	it('counts the group like the others', () => {
		const candidate = (i: number, kind: DigestCandidate['kind']): DigestCandidate => ({
			threadId: `t${i}` as Id<'mailThreads'>,
			messageId: `m${i}` as Id<'mailMessages'>,
			throughSourceOrderKey: `k${i}`,
			kind,
		});
		const selection = selectDigest([
			...Array.from({ length: 7 }, (_, i) => candidate(i, 'cold_outreach')),
			candidate(9, 'promotion'),
		]);
		expect(selection.items.filter((item) => item.kind === 'cold_outreach')).toHaveLength(5);
		expect(selection.overflowByKind).toEqual({
			newsletter: 0,
			updates: 0,
			promotion: 0,
			cold_outreach: 2,
		});
	});
});

describe('the labelled sample and its release gate', () => {
	it('holds both labels, first-contact asks for a call among the non-pitches', () => {
		const ids = COLD_PITCH_SAMPLE.map((sample) => sample.id);
		expect(new Set(ids).size).toBe(ids.length);
		const pitches = COLD_PITCH_SAMPLE.filter((sample) => sample.label === 'pitch');
		const others = COLD_PITCH_SAMPLE.filter((sample) => sample.label === 'not_pitch');
		expect(pitches.length).toBeGreaterThanOrEqual(10);
		expect(others.length).toBeGreaterThanOrEqual(10);
		expect(
			others.filter((sample) => /call|interview|coffee|telefon/i.test(sample.text)).length
		).toBeGreaterThanOrEqual(5);
	});

	it('sends each sample through the production prompt', () => {
		const prompt = coldPitchEvalPrompt(COLD_PITCH_SAMPLE[0]!);
		expect(prompt).toContain(COLD_PITCH_QUESTION);
		expect(prompt).toContain(COLD_PITCH_SAMPLE[0]!.text);
	});

	it('passes the oracle and fails on a single false positive', async () => {
		const label = new Map(COLD_PITCH_SAMPLE.map((sample) => [sample.text, sample.label]));
		const textOf = (prompt: string) => [...label.keys()].find((text) => prompt.includes(text));
		const oracle = await runColdPitchEval(COLD_PITCH_SAMPLE, async (prompt) =>
			label.get(textOf(prompt)!) === 'pitch' ? 'yes' : 'no'
		);
		expect(oracle).toMatchObject({ gate: 'passed', precision: 1, recall: 1, falsePositives: 0 });

		const answers = new Map(
			COLD_PITCH_SAMPLE.map((sample) => [
				sample.id,
				sample.label === 'pitch' || sample.id === 'customer-quote'
					? ('yes' as const)
					: ('no' as const),
			])
		);
		const report = scoreColdPitchRun(COLD_PITCH_SAMPLE, answers);
		expect(report).toMatchObject({ gate: 'failed', falsePositiveIds: ['customer-quote'] });
	});

	it('fails on low recall, and a failed call is never a positive', async () => {
		const report = await runColdPitchEval(COLD_PITCH_SAMPLE, async () => {
			throw new Error('provider down');
		});
		expect(report).toMatchObject({ gate: 'failed', truePositives: 0, falsePositives: 0 });
		expect(report.failedIds).toHaveLength(COLD_PITCH_SAMPLE.length);
	});
});
