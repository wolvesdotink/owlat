/**
 * The labelled sample for the cold-pitch question (#1381, `../coldPitch.ts`):
 * first mail from senders the reader has never written to, each labelled
 * `pitch` (unsolicited sales outreach) or `not_pitch`.
 *
 * Every message is one R2 would ask about, so every `not_pitch` is a
 * first-contact message too, and many ask for a call or a meeting the way a
 * pitch does: a false yes there hides real mail from the Answer queue, which
 * is what the release gate (`coldPitchEval.ts`) guards against. English and
 * German, since both are shipped locales. All names and domains are invented.
 *
 * Pure data; isolate-safe.
 */

export type ColdPitchLabel = 'pitch' | 'not_pitch';

export interface ColdPitchSample {
	id: string;
	label: ColdPitchLabel;
	subject: string;
	text: string;
}

export const COLD_PITCH_SAMPLE: readonly ColdPitchSample[] = [
	// ── Cold pitches ─────────────────────────────────────────────────────────
	{
		id: 'seo-agency',
		label: 'pitch',
		subject: 'Quick question about your website',
		text: 'Hi, I came across your website and noticed it is not ranking for several high-value keywords. Our agency has helped 200+ companies double their organic traffic in 90 days. Would you be open to a quick 15-minute call this week to see if we can do the same for you?',
	},
	{
		id: 'lead-gen',
		label: 'pitch',
		subject: '50 qualified meetings per month',
		text: 'Hello, we book qualified sales meetings for B2B companies like yours. Clients typically see 30 to 50 new meetings per month. Do you have 10 minutes on Thursday or Friday for a short intro call?',
	},
	{
		id: 'offshore-dev',
		label: 'pitch',
		subject: 'Dedicated developers at 40% lower cost',
		text: 'Hi there, we provide dedicated React and Node.js developers starting at $25/hour. Our teams integrate with yours within a week. Can I send over some profiles, or would you prefer a quick call to discuss your roadmap?',
	},
	{
		id: 'saas-demo',
		label: 'pitch',
		subject: 'Cut your invoicing time in half',
		text: 'Hi, finance teams spend hours every week chasing invoices. Our platform automates reminders and reconciliation. I would love to show you a 20-minute demo. What does your calendar look like next Tuesday?',
	},
	{
		id: 'bump',
		label: 'pitch',
		subject: 'Re: Partnership opportunity',
		text: 'Just bumping this to the top of your inbox. I reached out last week about our affiliate partnership programme, which pays 30% recurring commission. Are you the right person to talk to, or could you point me to someone who is?',
	},
	{
		id: 'guest-post',
		label: 'pitch',
		subject: 'Guest post collaboration',
		text: 'Hello, I am a content manager and would like to contribute a high-quality guest post to your blog in exchange for a do-follow link. We can also offer paid placements. Let me know your rates.',
	},
	{
		id: 'investment',
		label: 'pitch',
		subject: 'Exclusive pre-IPO opportunity',
		text: 'Dear investor, we are offering a limited number of shares in a fast-growing fintech before its public listing. Minimum ticket is 10,000 EUR. Reply to this email to receive the investor deck and book a call with our advisor.',
	},
	{
		id: 'bookkeeping',
		label: 'pitch',
		subject: 'Outsource your bookkeeping',
		text: 'Hi, running a small business is hard enough. Let our certified accountants handle your bookkeeping for a flat 199 per month. Can we schedule a free consultation call?',
	},
	{
		id: 'design-refresh',
		label: 'pitch',
		subject: 'Your brand deserves better',
		text: 'Hey, I had a look at your landing page and I think a refreshed design could lift conversions significantly. I put together three quick ideas. Want me to walk you through them on a call?',
	},
	{
		id: 'sales-tool',
		label: 'pitch',
		subject: 'Is outbound on your radar this quarter?',
		text: 'Hi, teams using our sales engagement tool book 3x more meetings. I would like to learn how you currently handle outbound and share how others in your space are doing it. Open to a quick chat?',
	},
	{
		id: 'de-it-service',
		label: 'pitch',
		subject: 'IT-Betreuung für Ihr Unternehmen',
		text: 'Guten Tag, wir betreuen kleine und mittlere Unternehmen rund um IT-Sicherheit und Cloud. Gerne zeige ich Ihnen in einem kurzen Telefonat, wie Sie bis zu 30 Prozent Ihrer IT-Kosten sparen. Wann passt es Ihnen diese Woche?',
	},
	{
		id: 'de-leads',
		label: 'pitch',
		subject: 'Mehr Neukunden für Ihr Geschäft',
		text: 'Hallo, wir generieren qualifizierte Leads für Dienstleister in Ihrer Region. Haben Sie Interesse an einem unverbindlichen Erstgespräch? Ich freue mich auf Ihre Rückmeldung.',
	},

	// ── First contact that is not a pitch ───────────────────────────────────
	{
		id: 'customer-quote',
		label: 'not_pitch',
		subject: 'Request for a quote',
		text: 'Hello, we are a team of twelve and are looking at your product for our support desk. Could you send us a quote for annual billing? Happy to jump on a call if that is easier.',
	},
	{
		id: 'journalist',
		label: 'not_pitch',
		subject: 'Interview request for an article on remote work',
		text: 'Hi, I am writing a piece for a business magazine about how small companies run remote teams. Would you be available for a 20-minute interview by phone next week?',
	},
	{
		id: 'speaker-invite',
		label: 'not_pitch',
		subject: 'Invitation to speak at our meetup',
		text: 'Hello, I organise a monthly developer meetup in our city. We enjoyed your talk last year and would love to have you speak at our March event. Could we have a short call to discuss a date?',
	},
	{
		id: 'neighbour',
		label: 'not_pitch',
		subject: 'Your parcel',
		text: 'Hi, I live next door at number 14. A parcel for you was delivered to us yesterday. When would be a good time to drop it off?',
	},
	{
		id: 'user-bug',
		label: 'not_pitch',
		subject: 'Export to CSV fails',
		text: 'Hi, I use your app daily. Since the last update, exporting my contacts to CSV fails with an error. Could you take a look? I can share a screen recording if that helps.',
	},
	{
		id: 'introduction',
		label: 'not_pitch',
		subject: 'Intro via Maria Lopez',
		text: 'Hi, Maria Lopez suggested I get in touch. I am starting a small bakery and she said you helped her set up her online shop. Would you have time for a coffee to share what you learned?',
	},
	{
		id: 'job-application',
		label: 'not_pitch',
		subject: 'Application: frontend developer',
		text: 'Dear hiring team, I am applying for the frontend developer position on your careers page. My CV and portfolio are attached. I would be glad to discuss the role in an interview.',
	},
	{
		id: 'student',
		label: 'not_pitch',
		subject: 'Question about your open-source project',
		text: 'Hello, I am a computer science student and I am writing my thesis on your open-source library. Could I ask you a few questions about its design, by email or in a short video call?',
	},
	{
		id: 'supplier-order',
		label: 'not_pitch',
		subject: 'Your order 1182: delivery date',
		text: 'Hello, thank you for your order 1182. One item is back-ordered until the 14th. Should we ship the rest now and the missing item later, or send everything together?',
	},
	{
		id: 'client-project',
		label: 'not_pitch',
		subject: 'Website project for our practice',
		text: 'Hi, we are a physiotherapy practice and need a new website. A colleague recommended your studio. Could you tell us whether you have capacity this spring and roughly what it would cost?',
	},
	{
		id: 'de-kunde',
		label: 'not_pitch',
		subject: 'Anfrage zu Ihrem Angebot',
		text: 'Guten Tag, wir möchten Ihre Software für unser Team mit acht Personen einsetzen. Können Sie uns ein Angebot schicken? Gerne auch telefonisch, wenn das einfacher ist.',
	},
	{
		id: 'de-verein',
		label: 'not_pitch',
		subject: 'Einladung zum Sommerfest',
		text: 'Hallo, unser Sportverein feiert am 21. Juni sein Sommerfest und wir laden alle Nachbarn herzlich ein. Kannst du uns kurz sagen, ob du kommst und wie viele ihr seid?',
	},
];
