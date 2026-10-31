/**
 * Who may call each audience, content-library, delivery-report and settings
 * read, called through its public export with real sessions (see
 * queryAuthzFixtures.ts for the policies and what every row checks).
 *
 * The forms and import-progress reads are owner/admin only; the rest are
 * member-readable. Each row reads a seeded, non-empty fixture, so a read that
 * returned early on missing data could not hide an ungated path.
 */

import { describe, it, expect } from 'vitest';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	createTestDomain,
	createTestEmailSend,
	createTestEmailTemplate,
	createTestFormSubmission,
	createTestSegment,
	createTestTopic,
	createTestTransactionalEmail,
} from './factories';
import {
	OWNER,
	authzHarness,
	describeQueryMatrix,
	type Harness,
	type MatrixRow,
	type Seed,
} from './queryAuthzFixtures';

interface LibrarySeed extends Seed {
	propertyId: Id<'contactProperties'>;
	emailSendId: Id<'emailSends'>;
	blockId: Id<'emailBlocks'>;
	templateId: Id<'emailTemplates'>;
	formEndpointId: Id<'formEndpoints'>;
	segmentId: Id<'segments'>;
	storageId: Id<'_storage'>;
	topicId: Id<'topics'>;
	transactionalEmailId: Id<'transactionalEmails'>;
	transactionalSendId: Id<'transactionalSends'>;
}

async function libraryHarness(): Promise<{ t: Harness; seed: LibrarySeed }> {
	const { t, seed } = await authzHarness();
	const ids = await t.run(async (ctx) => {
		const now = Date.now();
		const { contactId, campaignId } = seed;
		const propertyId = await ctx.db.insert('contactProperties', {
			key: 'phone',
			label: 'Phone',
			type: 'string',
			createdAt: now,
		});
		await ctx.db.insert('contactPropertyValues', {
			contactId,
			propertyId,
			value: '+1 555 0100',
			createdAt: now,
			updatedAt: now,
		});
		const emailSendId = await ctx.db.insert(
			'emailSends',
			createTestEmailSend({ campaignId, contactId, status: 'sent', openedAt: now, openCount: 1 })
		);
		const blockId = await ctx.db.insert('emailBlocks', {
			name: 'Footer',
			content: '[]',
			usageCount: 0,
			createdAt: now,
			updatedAt: now,
		});
		const templateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
		const formEndpointId = await ctx.db.insert('formEndpoints', {
			name: 'Signup',
			fields: [{ key: 'email', label: 'Email', type: 'email', required: true }],
			isActive: true,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('formSubmissions', createTestFormSubmission({ formEndpointId, contactId }));
		await ctx.db.insert('integrationImports', {
			provider: 'mailchimp',
			status: 'failed',
			cursor: '0',
			imported: 1,
			updated: 0,
			skipped: 0,
			failed: 1,
			errors: ['list not found'],
			handleDuplicates: 'skip',
			startedAt: now,
		});
		await ctx.db.insert('domains', createTestDomain({ status: 'verified', verifiedAt: now }));
		await ctx.db.insert('trackingDomains', {
			domain: 'links.owlat.example',
			cnameTarget: 'track.owlat.example',
			isVerified: true,
			createdAt: now,
		});
		const storageId = await ctx.storage.store(new Blob(['logo']));
		await ctx.db.insert('mediaAssets', {
			storageId,
			filename: 'logo.png',
			mimeType: 'image/png',
			fileSize: 4,
			url: 'https://owlat.example/logo.png',
			tags: ['brand'],
			uploadedBy: OWNER,
			createdAt: now,
			updatedAt: now,
		});
		const segmentId = await ctx.db.insert('segments', createTestSegment());
		const topicId = await ctx.db.insert('topics', createTestTopic());
		await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: now });
		const transactionalEmailId = await ctx.db.insert(
			'transactionalEmails',
			createTestTransactionalEmail()
		);
		const transactionalSendId = await ctx.db.insert('transactionalSends', {
			kind: 'transactional',
			transactionalEmailId,
			email: 'reader@example.com',
			contactId,
			status: 'sent',
		});
		return {
			propertyId,
			emailSendId,
			blockId,
			templateId,
			formEndpointId,
			segmentId,
			storageId,
			topicId,
			transactionalEmailId,
			transactionalSendId,
		};
	});
	return { t, seed: { ...seed, ...ids } };
}

const page = { paginationOpts: { numItems: 10, cursor: null } };
const member = (
	query: MatrixRow<LibrarySeed>['query'],
	args?: MatrixRow<LibrarySeed>['args']
): MatrixRow<LibrarySeed> => ({ query, policy: 'member', args });

const ROWS: Record<string, MatrixRow<LibrarySeed>> = {
	'contacts.properties.listByOrganization': member(api.contacts.properties.listByOrganization),
	'contacts.propertyValues.countByProperty': member(
		api.contacts.propertyValues.countByProperty,
		(s) => ({ propertyId: s.propertyId })
	),
	'contacts.propertyValues.listByContact': member(
		api.contacts.propertyValues.listByContact,
		(s) => ({
			contactId: s.contactId,
		})
	),
	'contacts.relationships.listByContact': member(api.contacts.relationships.listByContact, (s) => ({
		contactId: s.contactId,
	})),
	'contacts.timeline.getTimelineStats': member(api.contacts.timeline.getTimelineStats, (s) => ({
		contactId: s.contactId,
	})),
	'delivery.sends.get': member(api.delivery.sends.get, (s) => ({ id: s.emailSendId })),
	'delivery.sends.getClickedContacts': member(api.delivery.sends.getClickedContacts, (s) => ({
		campaignId: s.campaignId,
	})),
	'delivery.sends.getLinkClickStats': member(api.delivery.sends.getLinkClickStats, (s) => ({
		campaignId: s.campaignId,
	})),
	'delivery.sends.getOpenedContacts': member(api.delivery.sends.getOpenedContacts, (s) => ({
		campaignId: s.campaignId,
	})),
	'delivery.sends.getOpensTimeline': member(api.delivery.sends.getOpensTimeline, (s) => ({
		campaignId: s.campaignId,
	})),
	'delivery.sends.getStatsByCampaign': member(api.delivery.sends.getStatsByCampaign, (s) => ({
		campaignId: s.campaignId,
	})),
	'domains.domains.getEmailDomainVerificationStatus': member(
		api.domains.domains.getEmailDomainVerificationStatus,
		() => ({ email: 'news@owlat.example' })
	),
	'domains.domains.listByOrganization': member(api.domains.domains.listByOrganization),
	'domains.domains.listVerified': member(api.domains.domains.listVerified),
	'domains.trackingDomains.listTrackingDomains': member(
		api.domains.trackingDomains.listTrackingDomains
	),
	'emailBlocks.blocks.get': member(api.emailBlocks.blocks.get, (s) => ({ blockId: s.blockId })),
	'emailBlocks.blocks.getStatsByTeam': member(api.emailBlocks.blocks.getStatsByTeam),
	'emailBlocks.blocks.list': member(api.emailBlocks.blocks.list),
	'emailTemplates.emails.get': member(api.emailTemplates.emails.get, (s) => ({
		templateId: s.templateId,
	})),
	'emailTemplates.emails.list': member(api.emailTemplates.emails.list, () => page),
	'emailTemplates.i18n.getForLanguage': member(api.emailTemplates.i18n.getForLanguage, (s) => ({
		templateId: s.templateId,
	})),
	'emailTemplates.organization.countByTypeByOrganization': member(
		api.emailTemplates.organization.countByTypeByOrganization
	),
	'forms.endpoints.getSubmissions': {
		query: api.forms.endpoints.getSubmissions,
		policy: 'admin',
		flag: 'forms',
		args: (s) => ({ formEndpointId: s.formEndpointId }),
	},
	'forms.endpoints.listByTeam': {
		query: api.forms.endpoints.listByTeam,
		policy: 'admin',
		flag: 'forms',
	},
	'integrationImports.walker.getImportProgress': {
		query: api.integrationImports.walker.getImportProgress,
		policy: 'admin',
	},
	'mediaAssets.getStats': member(api.mediaAssets.getStats),
	'mediaAssets.list': member(api.mediaAssets.list, () => page),
	'mediaAssets.listTags': member(api.mediaAssets.listTags),
	'segments.get': member(api.segments.get, (s) => ({ id: s.segmentId })),
	'segments.list': member(api.segments.list, () => page),
	'storage.getUrl': member(api.storage.getUrl, (s) => ({ storageId: s.storageId })),
	'topics.topics.get': member(api.topics.topics.get, (s) => ({ topicId: s.topicId })),
	'topics.topics.getContactInTopicDetails': member(
		api.topics.topics.getContactInTopicDetails,
		(s) => ({ topicId: s.topicId, contactId: s.contactId })
	),
	'topics.topics.getContacts': member(api.topics.topics.getContacts, (s) => ({
		topicId: s.topicId,
		...page,
	})),
	'topics.topics.getTopicsForContact': member(api.topics.topics.getTopicsForContact, (s) => ({
		contactId: s.contactId,
	})),
	'topics.topics.list': member(api.topics.topics.list, () => page),
	'transactional.emails.countByStatus': {
		...member(api.transactional.emails.countByStatus),
		flag: 'transactional',
	},
	'transactional.emails.get': {
		...member(api.transactional.emails.get, (s) => ({ id: s.transactionalEmailId })),
		flag: 'transactional',
	},
	'transactional.emails.list': {
		...member(api.transactional.emails.list),
		flag: 'transactional',
	},
	'transactional.sends.get': {
		...member(api.transactional.sends.get, (s) => ({ id: s.transactionalSendId })),
		flag: 'transactional',
	},
	'transactional.sends.getCounts': {
		...member(api.transactional.sends.getCounts),
		flag: 'transactional',
	},
	'transactional.sends.listByTransactionalEmail': {
		...member(api.transactional.sends.listByTransactionalEmail, (s) => ({
			transactionalEmailId: s.transactionalEmailId,
		})),
		flag: 'transactional',
	},
	'transactional.translations.getForLanguage': {
		...member(api.transactional.translations.getForLanguage, (s) => ({
			id: s.transactionalEmailId,
		})),
		flag: 'transactional',
	},
	'workspaces.settings.get': member(api.workspaces.settings.get),
};

describe('query authorization matrix: audience, library, delivery and settings reads', () => {
	it('covers every reviewed definition', () => {
		expect(Object.keys(ROWS)).toHaveLength(44);
	});

	describeQueryMatrix(ROWS, libraryHarness);
});
