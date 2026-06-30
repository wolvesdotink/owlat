import { emailSentEditorModule } from './email_sent';
import { emailOpenedEditorModule } from './email_opened';
import { emailClickedEditorModule } from './email_clicked';
import { emailBouncedEditorModule } from './email_bounced';
import { emailComplainedEditorModule } from './email_complained';
import { topicSubscribedEditorModule } from './topic_subscribed';
import { topicUnsubscribedEditorModule } from './topic_unsubscribed';
import { topicConfirmedEditorModule } from './topic_confirmed';
import { doiAttestedEditorModule } from './doi_attested';
import { propertyUpdatedEditorModule } from './property_updated';
import { createdEditorModule } from './created';
import { inboundReceivedEditorModule } from './inbound_received';
import { inboundRepliedEditorModule } from './inbound_replied';
import type {
	ContactActivityEditorModuleMap,
	ContactActivityType,
} from './types';

export const ACTIVITY_EDITOR_MODULES: ContactActivityEditorModuleMap = {
	email_sent: emailSentEditorModule,
	email_opened: emailOpenedEditorModule,
	email_clicked: emailClickedEditorModule,
	email_bounced: emailBouncedEditorModule,
	email_complained: emailComplainedEditorModule,
	topic_subscribed: topicSubscribedEditorModule,
	topic_unsubscribed: topicUnsubscribedEditorModule,
	topic_confirmed: topicConfirmedEditorModule,
	doi_attested: doiAttestedEditorModule,
	property_updated: propertyUpdatedEditorModule,
	created: createdEditorModule,
	inbound_received: inboundReceivedEditorModule,
	inbound_replied: inboundRepliedEditorModule,
};

export function contactActivityEditorModuleFor<L extends ContactActivityType>(
	literal: L,
): ContactActivityEditorModuleMap[L] {
	return ACTIVITY_EDITOR_MODULES[literal];
}

export type {
	ContactActivityType,
	ContactActivityDisplayConfig,
	ContactActivityEditorModule,
	ContactActivityEditorModuleMap,
	MetadataFor,
} from './types';
