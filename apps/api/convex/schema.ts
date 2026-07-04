import { defineSchema } from 'convex/server';
import { mailTables } from './schema/mail';
import { webhookTables } from './schema/webhooks';
import { topicTables } from './schema/topics';
import { formTables } from './schema/forms';
import { automationTables } from './schema/automations';
import { campaignTables } from './schema/campaigns';
import { domainTables } from './schema/domains';
import { contactTables } from './schema/contacts';
import { authTables } from './schema/auth';
import { templateTables } from './schema/templates';
import { deliveryTables } from './schema/delivery';
import { inboxTables } from './schema/inbox';
import { autonomyTables } from './schema/autonomy';
import { askEagernessTables } from './schema/askEagerness';
import { knowledgeTables } from './schema/knowledge';
import { messagingTables } from './schema/messaging';
import { dashboardTables } from './schema/dashboard';
import { integrationTables } from './schema/integrations';
import { codeWorkTables } from './schema/codeWork';
import { chatTables } from './schema/chat';
import { assistantTables } from './schema/assistant';
import { draftStreamTables } from './schema/draftStream';

// Note: Team invites are now handled by BetterAuth organization plugin's invitation table

export default defineSchema({
	...mailTables,
	...webhookTables,
	...topicTables,
	...formTables,
	...automationTables,
	...campaignTables,
	...domainTables,
	...contactTables,
	...authTables,
	...templateTables,
	...deliveryTables,
	...inboxTables,
	...autonomyTables,
	...askEagernessTables,
	...knowledgeTables,
	...messagingTables,
	...dashboardTables,
	...integrationTables,
	...codeWorkTables,
	...chatTables,
	...assistantTables,
	...draftStreamTables,
});
