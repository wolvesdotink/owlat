/**
 * Who may call each reviewed read: every query whose authorization decision
 * this suite pins, called through its public export with real sessions.
 *
 *   member  any org role (owner, admin, editor) reads it;
 *   admin   owner/admin only, an editor is refused `forbidden`;
 *   self    any org role, but only for the caller's own user id.
 *
 * Every row also refuses an anonymous caller (`unauthenticated`) and a
 * signed-in identity without membership (`forbidden`) before reading data,
 * and a row behind a feature flag refuses every role while the flag is off.
 */

import { describe, it, expect } from 'vitest';
import { api } from '../_generated/api';
import { authzHarness, describeQueryMatrix, type MatrixRow } from './queryAuthzFixtures';

const page = { paginationOpts: { numItems: 10, cursor: null } };

const ROWS: Record<string, MatrixRow> = {
	'analytics.adaptiveDashboard.getLayout': {
		query: api.analytics.adaptiveDashboard.getLayout,
		policy: 'member',
	},
	'analytics.adaptiveDashboard.getRawLayout': {
		query: api.analytics.adaptiveDashboard.getRawLayout,
		policy: 'member',
	},
	'analytics.dashboard.getRecentActivity': {
		query: api.analytics.dashboard.getRecentActivity,
		policy: 'admin',
		args: () => ({ limit: 5 }),
	},
	'analytics.dashboard.getStats': { query: api.analytics.dashboard.getStats, policy: 'member' },
	'analytics.reputationQueries.getCampaignSendEstimate': {
		query: api.analytics.reputationQueries.getCampaignSendEstimate,
		policy: 'member',
		args: () => ({ recipientCount: 10 }),
	},
	'analytics.reputationQueries.getSendingOverview': {
		query: api.analytics.reputationQueries.getSendingOverview,
		policy: 'member',
	},
	'auth.accountManagement.getPendingDeletionRequest': {
		query: api.auth.accountManagement.getPendingDeletionRequest,
		policy: 'self',
		args: (_seed, caller) => ({ userId: caller }),
	},
	'auth.onboarding.getWithActualProgress': {
		query: api.auth.onboarding.getWithActualProgress,
		policy: 'self',
		args: (_seed, caller) => ({ userId: caller }),
	},
	'automations.analytics.getAutomationRuns': {
		query: api.automations.analytics.getAutomationRuns,
		policy: 'member',
		flag: 'automations',
		args: (seed) => ({ automationId: seed.automationId }),
	},
	'automations.analytics.getAutomationStats': {
		query: api.automations.analytics.getAutomationStats,
		policy: 'member',
		flag: 'automations',
		args: (seed) => ({ automationId: seed.automationId }),
	},
	'automations.analytics.getStepAnalytics': {
		query: api.automations.analytics.getStepAnalytics,
		policy: 'member',
		flag: 'automations',
		args: (seed) => ({ automationId: seed.automationId }),
	},
	'automations.automations.countByStatus': {
		query: api.automations.automations.countByStatus,
		policy: 'member',
		flag: 'automations',
	},
	'automations.automations.get': {
		query: api.automations.automations.get,
		policy: 'member',
		flag: 'automations',
		args: (seed) => ({ automationId: seed.automationId }),
	},
	'automations.automations.getWithRelations': {
		query: api.automations.automations.getWithRelations,
		policy: 'member',
		flag: 'automations',
		args: (seed) => ({ automationId: seed.automationId }),
	},
	'automations.automations.list': {
		query: api.automations.automations.list,
		policy: 'member',
		flag: 'automations',
		args: () => page,
	},
	'blockedEmails.getByEmail': {
		query: api.blockedEmails.getByEmail,
		policy: 'member',
		args: () => ({ email: 'reader@example.com' }),
	},
	'blockedEmails.getCountsByReason': {
		query: api.blockedEmails.getCountsByReason,
		policy: 'member',
	},
	'blockedEmails.listByTeam': { query: api.blockedEmails.listByTeam, policy: 'member' },
	'campaigns.abTest.getABTestStats': {
		query: api.campaigns.abTest.getABTestStats,
		policy: 'member',
		flag: 'campaigns',
		args: (seed) => ({ campaignId: seed.campaignId }),
	},
	'campaigns.audienceResolution.countRecipients': {
		query: api.campaigns.audienceResolution.countRecipients,
		policy: 'member',
		flag: 'campaigns',
	},
	'campaigns.campaigns.getWithRelations': {
		query: api.campaigns.campaigns.getWithRelations,
		policy: 'member',
		flag: 'campaigns',
		args: (seed) => ({ campaignId: seed.campaignId }),
	},
	'campaigns.campaigns.list': {
		query: api.campaigns.campaigns.list,
		policy: 'member',
		flag: 'campaigns',
		args: () => page,
	},
	'campaigns.organization.countByStatusByOrganization': {
		query: api.campaigns.organization.countByStatusByOrganization,
		policy: 'member',
		flag: 'campaigns',
	},
	'chat.dms.listMyDms': { query: api.chat.dms.listMyDms, policy: 'member', flag: 'chat' },
	'chat.mentions.countMyUnreadMentions': {
		query: api.chat.mentions.countMyUnreadMentions,
		policy: 'member',
		flag: 'chat',
	},
	'chat.mentions.listMyUnreadMentions': {
		query: api.chat.mentions.listMyUnreadMentions,
		policy: 'member',
		flag: 'chat',
	},
	'chat.mentions.searchOrgMembersForMention': {
		query: api.chat.mentions.searchOrgMembersForMention,
		policy: 'member',
		flag: 'chat',
	},
	'chat.messages.myUnreadCounts': {
		query: api.chat.messages.myUnreadCounts,
		policy: 'member',
		flag: 'chat',
	},
	'chat.rooms.getRoom': {
		query: api.chat.rooms.getRoom,
		policy: 'member',
		flag: 'chat',
		args: (seed) => ({ roomId: seed.publicRoomId }),
	},
	'chat.rooms.listMyChannels': {
		query: api.chat.rooms.listMyChannels,
		policy: 'member',
		flag: 'chat',
	},
	'chat.rooms.listPublicChannels': {
		query: api.chat.rooms.listPublicChannels,
		policy: 'member',
		flag: 'chat',
	},
	'contacts.activities.listByContact': {
		query: api.contacts.activities.listByContact,
		policy: 'member',
		args: (seed) => ({ contactId: seed.contactId }),
	},
	'contacts.analytics.getAudienceStats': {
		query: api.contacts.analytics.getAudienceStats,
		policy: 'member',
	},
	'contacts.analytics.getRecent': { query: api.contacts.analytics.getRecent, policy: 'member' },
	'contacts.analytics.getSubscriberGrowth': {
		query: api.contacts.analytics.getSubscriberGrowth,
		policy: 'member',
	},
	'contacts.contacts.get': {
		query: api.contacts.contacts.get,
		policy: 'member',
		args: (seed) => ({ contactId: seed.contactId }),
	},
	'contacts.contacts.list': {
		query: api.contacts.contacts.list,
		policy: 'member',
		args: () => page,
	},
	'contacts.identities.getMergeSuggestions': {
		query: api.contacts.identities.getMergeSuggestions,
		policy: 'member',
		args: (seed) => ({ contactId: seed.contactId }),
	},
	'contacts.identities.listByContact': {
		query: api.contacts.identities.listByContact,
		policy: 'member',
		args: (seed) => ({ contactId: seed.contactId }),
	},
	'contacts.organization.getPropertyValuesForContacts': {
		query: api.contacts.organization.getPropertyValuesForContacts,
		policy: 'admin',
		args: (seed) => ({ contactIds: [seed.contactId] }),
	},
	'contacts.organization.listAllIdsByOrganization': {
		query: api.contacts.organization.listAllIdsByOrganization,
		policy: 'admin',
	},
	'contacts.organization.listForExportByOrganization': {
		query: api.contacts.organization.listForExportByOrganization,
		policy: 'admin',
	},
};

describe('query authorization matrix', () => {
	it('covers every reviewed definition', () => {
		expect(Object.keys(ROWS)).toHaveLength(42);
	});

	describeQueryMatrix(ROWS, () => authzHarness());
});
