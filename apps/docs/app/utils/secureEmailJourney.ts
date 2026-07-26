/**
 * Data for the `::secure-email-journey` illustration on the Secure Email guide.
 *
 * Lives beside the components rather than inside them so the two flows — the
 * ordinary hop-by-hop route and the sealed route — can be read and edited as
 * prose without scrolling past ~200 lines of layout CSS.
 */

/** One system a message passes through on its way to the recipient. */
export interface SecureEmailJourneyNode {
	label: string;
	detail: string;
	/** `Sealed` renders the success treatment; anything else reads as plaintext. */
	badge: string;
	/** `d` attribute of a single 24×24 stroked path. */
	icon: string;
}

export interface SecureEmailJourneyFlow {
	id: 'transport' | 'sealed';
	eyebrow: string;
	title: string;
	detail: string;
	state: string;
	nodes: SecureEmailJourneyNode[];
	/** Label per hop; always `nodes.length - 1` entries. */
	links: string[];
}

export const secureEmailJourneyFlows: SecureEmailJourneyFlow[] = [
	{
		id: 'transport',
		eyebrow: 'Ordinary secure email',
		title: 'TLS protects each connection',
		detail: 'The message is opened and handled again at every mail server.',
		state: 'Hop-by-hop',
		nodes: [
			{
				label: 'Sender',
				detail: 'Mail app',
				badge: 'Readable',
				icon: 'M4 4h16v16H4zM4 7l8 6 8-6',
			},
			{
				label: 'Sending server',
				detail: 'Queues + routes',
				badge: 'Can read',
				icon: 'M4 6h16v5H4zM4 13h16v5H4zM7 8.5h.01M7 15.5h.01',
			},
			{
				label: 'Receiving server',
				detail: 'Filters + stores',
				badge: 'Can read',
				icon: 'M4 6h16v5H4zM4 13h16v5H4zM17 8.5h.01M17 15.5h.01',
			},
			{
				label: 'Recipient',
				detail: 'Mail app',
				badge: 'Readable',
				icon: 'M3 19V9l9-6 9 6v10H3zm0-10l9 6 9-6',
			},
		],
		links: ['TLS', 'STARTTLS', 'TLS'],
	},
	{
		id: 'sealed',
		eyebrow: 'Owlat Sealed Mail',
		title: 'The message stays sealed across the route',
		detail: 'Transport TLS still protects the links, while OpenPGP protects the message itself.',
		state: 'End-to-end',
		nodes: [
			{
				label: 'Sender workspace',
				detail: 'Seal + sign',
				badge: 'Readable',
				icon: 'M7 11V8a5 5 0 0110 0v3m-9 0h8a2 2 0 012 2v7H6v-7a2 2 0 012-2z',
			},
			{
				label: 'Sending server',
				detail: 'Routes ciphertext',
				badge: 'Sealed',
				icon: 'M4 6h16v5H4zM4 13h16v5H4zM7 8.5h.01M7 15.5h.01',
			},
			{
				label: 'Receiving server',
				detail: 'Receives ciphertext',
				badge: 'Sealed',
				icon: 'M4 6h16v5H4zM4 13h16v5H4zM17 8.5h.01M17 15.5h.01',
			},
			{
				label: 'Recipient workspace',
				detail: 'Open + verify',
				badge: 'Readable',
				icon: 'M17 11V8a5 5 0 00-9.9-1M8 11h8a2 2 0 012 2v7H6v-7a2 2 0 012-2z',
			},
		],
		links: ['TLS + sealed', 'STARTTLS + sealed', 'TLS + sealed'],
	},
];
