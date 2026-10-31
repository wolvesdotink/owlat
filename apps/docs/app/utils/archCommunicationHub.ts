/**
 * Data for the `::arch-communication-hub` diagram on the Vision page.
 *
 * Lives beside the components rather than inside them so the diagram's copy
 * can be read and edited without scrolling past the layout CSS.
 */

/** `d` attribute of a single 24×24 stroked path. */
type IconPath = string;

export interface CommunicationHubChannel {
	name: string;
	icon: IconPath;
}

export interface CommunicationHubStage {
	name: string;
	detail: string;
}

export interface CommunicationHubKnowledgeType {
	name: string;
	/** Picks the `hub-knowledge-tag--<color>` treatment. */
	color: 'brand' | 'accent' | 'info';
}

export interface CommunicationHubQueueAction {
	name: string;
	icon: IconPath;
}

export const communicationHubChannels: CommunicationHubChannel[] = [
	{
		name: 'Email',
		icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
	},
	{
		name: 'SMS',
		icon: 'M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z',
	},
	{
		name: 'Chat',
		icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
	},
	{
		name: 'Webhooks',
		icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1',
	},
	{
		name: 'Owlat',
		icon: 'M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2 2 0 01-2 2H5a2 2 0 01-2-2V5.25A2 2 0 015.25 3h13.5A2 2 0 0121 5.25z',
	},
];

export const communicationHubPipelineSteps: CommunicationHubStage[] = [
	{ name: 'Context', detail: 'Retrieve' },
	{ name: 'Classify', detail: 'Intent' },
	{ name: 'Plan', detail: 'Action' },
	{ name: 'Draft', detail: 'Generate' },
];

export const communicationHubFilterLayers: CommunicationHubStage[] = [
	{ name: 'Prompt injection', detail: 'Direct injection, delimiter attacks, role impersonation' },
	{ name: 'Instruction smuggling', detail: 'Hidden HTML, invisible text, image alt text' },
	{ name: 'Content policy', detail: 'Spam keywords, phishing URLs, prohibited content' },
	{ name: 'Metadata stripping', detail: 'HTML → structured text, header filtering' },
];

export const communicationHubKnowledgeTypes: CommunicationHubKnowledgeType[] = [
	{ name: 'Facts', color: 'brand' },
	{ name: 'Decisions', color: 'accent' },
	{ name: 'Events', color: 'info' },
];

export const communicationHubQueueActions: CommunicationHubQueueAction[] = [
	{ name: 'Approve', icon: 'M5 13l4 4L19 7' },
	{
		name: 'Edit',
		icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
	},
	{ name: 'Reject', icon: 'M6 18L18 6M6 6l12 12' },
];
