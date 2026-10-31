/**
 * Data for the `::arch-data-model` diagram on the vision page: the entity
 * layers, which entities light up together on hover, and the legend.
 */

type EntityType = 'core' | 'people' | 'contact' | 'channel' | 'content' | 'intelligence';

interface Entity {
	id: string;
	type: EntityType;
	label: string;
	detail: string;
}

interface Layer {
	label: string;
	sublabel: string;
	entities: Entity[];
}

export const typeConfig: Record<EntityType, { color: string; icon: string; label: string }> = {
	core: {
		color: 'brand',
		icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4',
		label: 'Core',
	},
	people: {
		color: 'brand',
		icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
		label: 'People',
	},
	contact: {
		color: 'accent',
		icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
		label: 'Contacts',
	},
	channel: {
		color: 'info',
		icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
		label: 'Communication',
	},
	content: {
		color: 'warning',
		icon: 'M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z',
		label: 'Content',
	},
	intelligence: {
		color: 'success',
		icon: 'M13 10V3L4 14h7v7l9-11h-7z',
		label: 'Intelligence',
	},
};

export const layers: Layer[] = [
	{
		label: 'Tenant',
		sublabel: 'Root scope',
		entities: [
			{
				id: 'org',
				type: 'core',
				label: 'Organization',
				detail: 'Tenant root — all data scoped here',
			},
		],
	},
	{
		label: 'Actors & Channels',
		sublabel: 'Participants',
		entities: [
			{
				id: 'member',
				type: 'people',
				label: 'Member',
				detail: 'Org employees with roles & permissions',
			},
			{
				id: 'contact',
				type: 'contact',
				label: 'Contact',
				detail: 'Customers, investors, partners, vendors',
			},
			{
				id: 'channel',
				type: 'channel',
				label: 'Channel',
				detail: 'Email, SMS, Chat, Owlat, Webhooks',
			},
			{
				id: 'agent',
				type: 'intelligence',
				label: 'Agent',
				detail: 'AI workers — draft, classify, visualize',
			},
		],
	},
	{
		label: 'Threads',
		sublabel: 'Universal hub',
		entities: [
			{
				id: 'conversation',
				type: 'channel',
				label: 'Conversation',
				detail: 'Threaded message stream across channels',
			},
		],
	},
	{
		label: 'Artifacts',
		sublabel: 'What conversations produce',
		entities: [
			{
				id: 'message',
				type: 'channel',
				label: 'Message',
				detail: 'Human or agent authored content',
			},
			{ id: 'file', type: 'content', label: 'File', detail: 'Embedded, tagged, version-tracked' },
			{
				id: 'knowledge',
				type: 'intelligence',
				label: 'Knowledge Node',
				detail: 'Facts, decisions, events, preferences',
			},
		],
	},
];

// Connections between entities (for highlighting)
export const connections: Record<string, string[]> = {
	org: ['member', 'contact', 'channel', 'agent'],
	member: ['org', 'conversation', 'agent'],
	contact: ['org', 'conversation', 'knowledge'],
	channel: ['org', 'conversation'],
	agent: ['org', 'conversation', 'knowledge', 'member'],
	conversation: ['member', 'contact', 'channel', 'agent', 'message'],
	message: ['conversation', 'file', 'knowledge'],
	file: ['message', 'knowledge'],
	knowledge: ['message', 'file', 'agent', 'contact'],
};

export const legendTypes = [
	{ color: 'brand', label: 'Core & People', icon: typeConfig.core.icon },
	{ color: 'accent', label: 'Contacts', icon: typeConfig.contact.icon },
	{ color: 'info', label: 'Communication', icon: typeConfig.channel.icon },
	{ color: 'warning', label: 'Content', icon: typeConfig.content.icon },
	{ color: 'success', label: 'Intelligence', icon: typeConfig.intelligence.icon },
];
