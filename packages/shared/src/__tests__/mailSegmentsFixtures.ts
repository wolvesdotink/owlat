/**
 * Real-world-shaped bodies for the `segmentMessage` table test. Every name and
 * address is fictional (`example.com`).
 *
 * `expect` lists the segments in order as `[kind, text the segment contains,
 * author name or email?]`.
 */
import type { SegmentKind, UncertainReason } from '../mailSegments';

export interface SegmentCase {
	name: string;
	text?: string;
	html?: string;
	expect: Array<[SegmentKind, string, string?]>;
	uncertain?: UncertainReason[];
	/** Text that must not appear in the canonical text. */
	absent?: string[];
}

const J = 'Jonas Weber <jonas@example.com>';

export const SEGMENT_CASES: SegmentCase[] = [
	// ── Empty and fresh-only ──
	{ name: 'empty text', text: '', expect: [] },
	{ name: 'empty html falls back to empty text', html: '<div><br></div>', expect: [] },
	{ name: 'whitespace-only text', text: ' \n\n\t\n', expect: [] },
	{
		name: 'plain fresh message',
		text: 'Hi Mara,\n\nCould you send the contract by Friday?\n',
		expect: [['fresh', 'send the contract by Friday']],
	},
	{
		name: 'prose that mentions writing is not an attribution',
		text: 'On Monday she wrote the plan, and I will review it.\nPlease send the numbers.',
		expect: [['fresh', 'Please send the numbers']],
	},
	{
		name: 'a lone From: line is not a header block',
		text: 'From: the warehouse team\nThe pallets arrive on Tuesday.',
		expect: [['fresh', 'The pallets arrive']],
	},

	// ── Gmail ──
	{
		name: 'Gmail plain-text reply (EN)',
		text: `Works for me.\n\nOn Mon, 5 Oct 2026 at 10:00, ${J} wrote:\n> Can we move the call to Tuesday?\n`,
		expect: [
			['fresh', 'Works for me.'],
			['quoted', 'move the call', 'jonas@example.com'],
		],
	},
	{
		name: 'Gmail attribution wrapped over two lines',
		text: 'Agreed.\n\nOn Mon, Oct 5, 2026 at 10:00 AM Jonas Weber <\njonas@example.com> wrote:\n> Shall we sign today?\n',
		expect: [
			['fresh', 'Agreed.'],
			['quoted', 'Shall we sign today?', 'Jonas Weber'],
		],
	},
	{
		name: 'Gmail HTML reply (EN)',
		html: '<div dir="ltr">See you then.</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Oct 5, 2026 at 10:00 AM Jonas Weber &lt;<a href="mailto:jonas@example.com">jonas@example.com</a>&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex"><div dir="ltr">Tuesday at 10?</div></blockquote></div>',
		expect: [
			['fresh', 'See you then.'],
			['quoted', 'Tuesday at 10?', 'jonas@example.com'],
		],
	},
	{
		name: 'Gmail HTML reply (DE)',
		html: '<div dir="ltr">Passt, danke!</div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">Am Mo., 5. Okt. 2026 um 10:00 Uhr schrieb Jonas Weber &lt;<a href="mailto:jonas@example.com">jonas@example.com</a>&gt;:<br></div><blockquote class="gmail_quote"><div dir="ltr">Kannst du am Dienstag?</div></blockquote></div>',
		expect: [
			['fresh', 'Passt, danke!'],
			['quoted', 'Kannst du am Dienstag?', 'jonas@example.com'],
		],
	},
	{
		name: 'Gmail HTML reply (FR)',
		html: '<div dir="ltr">Parfait.</div><div class="gmail_quote"><div dir="ltr" class="gmail_attr">Le lun. 5 oct. 2026 à 10:00, Jonas Weber &lt;jonas@example.com&gt; a écrit :<br></div><blockquote class="gmail_quote"><div>Pouvez-vous signer le devis ?</div></blockquote></div>',
		expect: [
			['fresh', 'Parfait.'],
			['quoted', 'signer le devis', 'jonas@example.com'],
		],
	},
	{
		name: 'Gmail HTML forward (EN)',
		html: '<div dir="ltr">Can you handle this one?<br><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername" dir="auto">Jonas Weber</strong> <span dir="auto">&lt;<a href="mailto:jonas@example.com">jonas@example.com</a>&gt;</span><br>Date: Mon, Oct 5, 2026 at 10:00 AM<br>Subject: Invoice 2231<br>To: &lt;mara@example.com&gt;<br></div><br><br><div dir="ltr">Please pay invoice 2231 by 14 October.</div></div></div>',
		expect: [
			['fresh', 'Can you handle this one?'],
			['forwarded', 'Please pay invoice 2231', 'jonas@example.com'],
		],
	},
	{
		name: 'Gmail plain forward (DE)',
		text: 'Kannst du das übernehmen?\n\n---------- Weitergeleitete Nachricht ---------\nVon: Jonas Weber <jonas@example.com>\nDate: Mo., 5. Okt. 2026 um 10:00 Uhr\nSubject: Angebot\nTo: <mara@example.com>\n\nBitte bestätigt das Angebot bis Freitag.\n',
		expect: [
			['fresh', 'übernehmen'],
			['forwarded', 'bestätigt das Angebot', 'Jonas Weber'],
		],
	},
	{
		name: 'Gmail plain forward (FR)',
		text: "Tu peux t'en occuper ?\n\n---------- Message transféré ---------\nDe : Jonas Weber <jonas@example.com>\nDate: lun. 5 oct. 2026 à 10:00\nSubject: Facture\nTo: <mara@example.com>\n\nMerci de régler la facture.\n",
		expect: [
			['fresh', "t'en occuper"],
			['forwarded', 'régler la facture', 'jonas@example.com'],
		],
	},

	// ── Outlook ──
	{
		name: 'Outlook desktop HTML reply (border-top header)',
		html: '<div class="WordSection1"><p class="MsoNormal">Approved, go ahead.</p><p class="MsoNormal">&nbsp;</p><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p class="MsoNormal"><b>From:</b> Jonas Weber &lt;jonas@example.com&gt;<br><b>Sent:</b> Monday, October 5, 2026 10:00 AM<br><b>To:</b> Mara Lind &lt;mara@example.com&gt;<br><b>Subject:</b> RE: Budget</p></div><p class="MsoNormal">Can you approve the budget?</p></div>',
		expect: [
			['fresh', 'Approved, go ahead.'],
			['quoted', 'Can you approve the budget?', 'jonas@example.com'],
		],
	},
	{
		name: 'Outlook on the web reply (divRplyFwdMsg)',
		html: '<div>Done, thanks.</div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri"><b>From:</b> Jonas Weber &lt;jonas@example.com&gt;<br><b>Sent:</b> Monday, October 5, 2026 10:00<br><b>To:</b> Mara Lind<br><b>Subject:</b> Report</font><div>&nbsp;</div></div><div>Please send the report.</div>',
		expect: [
			['fresh', 'Done, thanks.'],
			['quoted', 'Please send the report.', 'jonas@example.com'],
		],
	},
	{
		name: 'Outlook plain-text reply with separator (DE)',
		text: 'Ist erledigt.\n\n________________________________\nVon: Jonas Weber <jonas@example.com>\nGesendet: Montag, 5. Oktober 2026 10:00\nAn: Mara Lind <mara@example.com>\nBetreff: Rechnung\n\nBitte schick mir die Rechnung.\n',
		expect: [
			['fresh', 'Ist erledigt.'],
			['quoted', 'schick mir die Rechnung', 'jonas@example.com'],
		],
	},
	{
		name: 'Outlook plain-text forward (FW subject)',
		text: 'FYI, please take care of this.\n\nFrom: Jonas Weber <jonas@example.com>\nSent: Monday, October 5, 2026 10:00 AM\nTo: Mara Lind <mara@example.com>\nSubject: FW: Contract renewal\n\nThe contract renews on 1 November unless cancelled.\n',
		expect: [
			['fresh', 'take care of this'],
			['forwarded', 'renews on 1 November', 'jonas@example.com'],
		],
	},
	{
		name: 'Outlook plain-text forward (FR, TR subject)',
		text: "Peux-tu t'en charger ?\n\nDe : Jonas Weber <jonas@example.com>\nEnvoyé : lundi 5 octobre 2026 10:00\nÀ : Mara Lind <mara@example.com>\nObjet : TR: Devis\n\nMerci de valider le devis.\n",
		expect: [
			['fresh', "t'en charger"],
			['forwarded', 'valider le devis', 'jonas@example.com'],
		],
	},
	{
		name: 'Outlook -----Original Message----- (EN)',
		text: 'Yes, confirmed.\n\n-----Original Message-----\nFrom: Jonas Weber [mailto:jonas@example.com]\nSent: Monday, October 5, 2026 10:00 AM\nTo: Mara Lind\nSubject: Delivery\n\nCan you confirm delivery on Thursday?\n',
		expect: [
			['fresh', 'Yes, confirmed.'],
			['quoted', 'confirm delivery on Thursday', 'jonas@example.com'],
		],
	},
	{
		name: 'Outlook -----Ursprüngliche Nachricht----- (DE)',
		text: 'Ja, passt.\n\n-----Ursprüngliche Nachricht-----\nVon: Jonas Weber <jonas@example.com>\nGesendet: Montag, 5. Oktober 2026 10:00\nAn: Mara Lind\nBetreff: Termin\n\nPasst dir Donnerstag?\n',
		expect: [
			['fresh', 'Ja, passt.'],
			['quoted', 'Passt dir Donnerstag?', 'jonas@example.com'],
		],
	},

	// ── Apple Mail and Thunderbird ──
	{
		name: 'Apple Mail HTML reply (blockquote type=cite)',
		html: '<html><body><div>Sure, I will be there.</div><div><br><blockquote type="cite"><div>On 5 Oct 2026, at 10:00, Jonas Weber &lt;jonas@example.com&gt; wrote:</div><br><div><div>Will you join the workshop?</div></div></blockquote></div></body></html>',
		expect: [
			['fresh', 'I will be there.'],
			['quoted', 'join the workshop', 'jonas@example.com'],
		],
	},
	{
		name: 'Apple Mail HTML forward (Begin forwarded message)',
		html: '<div>Could you look at this?</div><div><br><div>Begin forwarded message:</div><br><blockquote type="cite"><div><b>From: </b>Jonas Weber &lt;jonas@example.com&gt;</div><div><b>Subject: </b>Access request</div><div><b>Date: </b>5 October 2026 at 10:00:00 CEST</div><div><b>To: </b>Mara Lind &lt;mara@example.com&gt;</div><br><div>Please grant me access to the shared folder.</div></blockquote></div>',
		expect: [
			['fresh', 'Could you look at this?'],
			['forwarded', 'grant me access', 'jonas@example.com'],
		],
	},
	{
		name: 'Apple Mail plain forward (DE)',
		text: 'Zur Info.\n\nAnfang der weitergeleiteten Nachricht:\n\nVon: Jonas Weber <jonas@example.com>\nBetreff: Lieferung\nDatum: 5. Oktober 2026 um 10:00:00 MESZ\nAn: Mara Lind <mara@example.com>\n\nDie Lieferung kommt am Donnerstag.\n',
		expect: [
			['fresh', 'Zur Info.'],
			['forwarded', 'Lieferung kommt am Donnerstag', 'jonas@example.com'],
		],
	},
	{
		name: 'Apple Mail plain reply (FR)',
		text: "D'accord.\n\nLe 5 oct. 2026 à 10:00, Jonas Weber <jonas@example.com> a écrit :\n> \n> On se voit jeudi ?\n",
		expect: [
			['fresh', "D'accord."],
			['quoted', 'On se voit jeudi', 'jonas@example.com'],
		],
	},
	{
		name: 'Thunderbird plain reply (DE, no address)',
		text: 'Danke, erledigt.\n\nAm 05.10.26 um 10:00 schrieb Jonas Weber:\n> Kannst du die Datei hochladen?\n',
		expect: [
			['fresh', 'Danke, erledigt.'],
			['quoted', 'Datei hochladen', 'Jonas Weber'],
		],
	},
	{
		name: 'Thunderbird forward (Forwarded Message banner)',
		text: 'See below.\n\n-------- Forwarded Message --------\nSubject: Renewal\nDate: Mon, 5 Oct 2026 10:00:00 +0200\nFrom: Jonas Weber <jonas@example.com>\nTo: Mara Lind <mara@example.com>\n\nThe renewal fee is EUR 1,200.\n',
		expect: [
			['fresh', 'See below.'],
			['forwarded', 'renewal fee', 'jonas@example.com'],
		],
	},

	// ── Inline replies and nesting ──
	{
		name: 'plain inline replies alternate quoted and fresh',
		text: `On Mon, 5 Oct 2026 at 10:00, ${J} wrote:\n> Can you do Tuesday?\n\nYes, Tuesday works.\n\n> And can you send the budget?\n\nI will send it tomorrow.\n`,
		expect: [
			['quoted', 'Can you do Tuesday?', 'jonas@example.com'],
			['fresh', 'Tuesday works'],
			['quoted', 'send the budget', 'jonas@example.com'],
			['fresh', 'send it tomorrow'],
		],
	},
	{
		name: 'Gmail HTML inline replies inside the quote container',
		html: '<div dir="ltr">Answers inline.</div><div class="gmail_quote"><div class="gmail_attr">On Mon, Oct 5, 2026 at 10:00 AM Jonas Weber &lt;jonas@example.com&gt; wrote:<br></div><blockquote class="gmail_quote"><div>1. Can you sign the NDA?</div></blockquote><div>Signed and attached.</div><blockquote class="gmail_quote"><div>2. Who joins the call?</div></blockquote><div>Lena and me.</div></div>',
		expect: [
			['fresh', 'Answers inline.'],
			['quoted', 'sign the NDA', 'jonas@example.com'],
			['fresh', 'Signed and attached.'],
			['quoted', 'Who joins the call?', 'jonas@example.com'],
			['fresh', 'Lena and me.'],
		],
	},
	{
		name: 'bottom-posted reply after an unattributed quote',
		text: '> Could you check the figures?\n> They look off.\n\nChecked, row 4 was wrong.\n',
		expect: [
			['quoted', 'check the figures'],
			['fresh', 'row 4 was wrong'],
		],
	},
	{
		name: 'nested quotes keep their own authors',
		text: `Fine by me.\n\nOn Tue, 6 Oct 2026 at 09:00, Lena Hofmann <lena@example.com> wrote:\n> I agree with Jonas.\n>\n> On Mon, 5 Oct 2026 at 10:00, ${J} wrote:\n>> Let us launch on 14 November.\n`,
		expect: [
			['fresh', 'Fine by me.'],
			['quoted', 'I agree with Jonas.', 'lena@example.com'],
			['quoted', 'launch on 14 November', 'jonas@example.com'],
		],
	},
	{
		name: 'nested forwards keep both senders',
		text: 'Please handle.\n\n---------- Forwarded message ---------\nFrom: Lena Hofmann <lena@example.com>\nDate: Tue, 6 Oct 2026 at 09:00\nSubject: Fwd: Invoice\nTo: Mara <mara@example.com>\n\nThis came in for you.\n\n---------- Forwarded message ---------\nFrom: Billing <billing@example.com>\nDate: Mon, 5 Oct 2026 at 08:00\nSubject: Invoice\nTo: Lena <lena@example.com>\n\nInvoice 2231 is due on 20 October.\n',
		expect: [
			['fresh', 'Please handle.'],
			['forwarded', 'This came in for you.', 'lena@example.com'],
			['forwarded', 'due on 20 October', 'billing@example.com'],
		],
	},
	{
		name: 'a forward that carries its own reply history',
		text: 'Over to you.\n\n---------- Forwarded message ---------\nFrom: Lena Hofmann <lena@example.com>\nDate: Tue, 6 Oct 2026 at 09:00\nSubject: Re: Venue\nTo: Mara <mara@example.com>\n\nThe venue confirmed.\n\nFrom: Jonas Weber <jonas@example.com>\nSent: Monday, October 5, 2026 10:00 AM\nTo: Lena Hofmann\nSubject: Venue\n\nIs the venue confirmed?\n',
		expect: [
			['fresh', 'Over to you.'],
			['forwarded', 'The venue confirmed.', 'lena@example.com'],
			['quoted', 'Is the venue confirmed?', 'jonas@example.com'],
		],
	},
	{
		name: 'bare forward without fresh text',
		text: '---------- Forwarded message ---------\nFrom: Jonas Weber <jonas@example.com>\nDate: Mon, 5 Oct 2026 at 10:00\nSubject: Agenda\nTo: <mara@example.com>\n\nAgenda attached.\n',
		expect: [['forwarded', 'Agenda attached.', 'jonas@example.com']],
	},
	{
		name: 'forward banner without a readable sender is uncertain',
		text: 'Look at this.\n\n---------- Forwarded message ---------\n\nPlease review the attached plan.\n',
		expect: [
			['fresh', 'Look at this.'],
			['forwarded', 'review the attached plan'],
		],
		uncertain: ['forward_without_author'],
	},

	// ── Signatures and disclaimers ──
	{
		name: 'RFC 3676 signature delimiter',
		text: 'The files are uploaded.\n\n-- \nJonas Weber\nAcme Studio\n+49 30 0000000\n',
		expect: [
			['fresh', 'files are uploaded'],
			['signature', 'Acme Studio'],
		],
	},
	{
		name: 'mobile signature (EN)',
		text: 'On my way, five minutes.\n\nSent from my iPhone\n',
		expect: [
			['fresh', 'On my way'],
			['signature', 'Sent from my iPhone'],
		],
	},
	{
		name: 'mobile signature (DE)',
		text: 'Bin unterwegs.\n\nVon meinem iPhone gesendet\n',
		expect: [
			['fresh', 'Bin unterwegs.'],
			['signature', 'Von meinem iPhone gesendet'],
		],
	},
	{
		name: 'closing and name block (FR)',
		text: 'Pouvez-vous confirmer la date ?\n\nCordialement,\nJonas Weber\nAcme Studio\n',
		expect: [
			['fresh', 'confirmer la date'],
			['signature', 'Cordialement'],
		],
	},
	{
		name: 'a closing as the first line stays fresh',
		text: 'Thanks!\nJonas\n',
		expect: [['fresh', 'Thanks!\nJonas']],
	},
	{
		name: 'a closing followed by a request is not a signature',
		text: 'Here is the update.\n\nBest,\nAlso, could you send me the final invoice for the October workshop by Friday?\n',
		expect: [['fresh', 'final invoice']],
	},
	{
		name: 'confidentiality notice after a signature (EN)',
		text: 'Please confirm the order.\n\nBest regards,\nJonas Weber\n\nThis e-mail and any attachments are confidential and intended solely for\nthe addressee. If you are not the intended recipient, please delete it.\n',
		expect: [
			['fresh', 'confirm the order'],
			['signature', 'Jonas Weber'],
			['disclaimer', 'intended recipient'],
		],
	},
	{
		name: 'confidentiality notice (DE)',
		text: 'Anbei das Angebot.\n\nViele Grüße\nJonas\n\nDiese E-Mail enthält vertrauliche Informationen. Wenn Sie nicht der richtige\nAdressat sind, informieren Sie bitte sofort den Absender.\n',
		expect: [
			['fresh', 'Anbei das Angebot.'],
			['signature', 'Viele Grüße'],
			['disclaimer', 'vertrauliche'],
		],
	},
	{
		name: 'confidentiality notice (FR, HTML paragraph)',
		html: "<p>Voici le contrat signé.</p><p>Bien à vous,<br>Jonas</p><p>Ce message et toutes les pièces jointes sont confidentiels et établis à l'intention exclusive de ses destinataires. Si vous n'êtes pas le destinataire, merci de le détruire.</p>",
		expect: [
			['fresh', 'contrat signé'],
			['signature', 'Bien à vous'],
			['disclaimer', 'confidentiels'],
		],
	},
	{
		name: 'company legal footer inside a signature (DE)',
		text: 'Die Ware ist versendet.\n\nViele Grüße\nJonas Weber\nAcme GmbH · Geschäftsführer: Max Muster · Amtsgericht Berlin HRB 12345\n',
		expect: [
			['fresh', 'versendet'],
			['signature', 'Jonas Weber'],
			['disclaimer', 'HRB 12345'],
		],
	},
	{
		name: 'legal words in running text stay fresh',
		text: 'The hearing at the Amtsgericht moved to Monday.\nCan you confirm you can attend?\n',
		expect: [['fresh', 'Can you confirm you can attend?']],
	},

	// ── Ambiguity ──
	{
		name: 'a lowercase line sandwiched in a quote is ambiguous',
		text: '> This is a long line that got\nwrapped by the client\n> and continues here.\n\nOk.\n',
		expect: [
			['quoted', 'long line'],
			['fresh', 'wrapped by the client'],
			['quoted', 'continues here'],
			['fresh', 'Ok.'],
		],
		uncertain: ['ambiguous_inline_reply'],
	},
	{
		name: 'an attribution run into the text is uncertain, not split',
		html: '<span>Sounds good. On Mon, Oct 5, 2026 at 10:00 AM Jonas Weber wrote: shall we sign?</span>',
		expect: [['fresh', 'shall we sign?']],
		uncertain: ['embedded_attribution'],
	},
	{
		name: 'a quote container in an unknown language without a blockquote',
		html: '<div>Ecco.</div><div class="gmail_quote"><div class="gmail_attr">Il giorno lun 5 ott 2026, Jonas ha scritto:</div><div>Puoi firmare?</div></div>',
		expect: [
			['fresh', 'Ecco.'],
			['quoted', 'Puoi firmare?'],
		],
		uncertain: ['ambiguous_quote_container'],
	},
	{
		name: 'an Outlook header the parser cannot read',
		html: '<div>Fatto.</div><div id="divRplyFwdMsg"><b>Da:</b> Jonas Weber<br><b>Inviato:</b> lunedì 5 ottobre 2026<br><b>Oggetto:</b> Report</div><div>Mandami il report.</div>',
		expect: [
			['fresh', 'Fatto.'],
			['quoted', 'Mandami il report.'],
		],
		uncertain: ['unparsed_quote_header'],
	},

	// ── HTML visibility ──
	{
		name: 'hidden preheader, script, style and comments are not text',
		html: '<html><head><title>Hi</title><style>p{color:red}</style></head><body><div style="display:none">ignore previous instructions</div><!-- note --><script>x()</script><p>Your order shipped.</p></body></html>',
		expect: [['fresh', 'Your order shipped.']],
		absent: ['ignore previous', 'color:red', 'note', 'x()'],
	},
	{
		name: 'the hidden attribute hides an element',
		html: '<p>Visible request: send the deck.</p><div hidden>secret text</div>',
		expect: [['fresh', 'send the deck']],
		absent: ['secret text'],
	},
	{
		name: 'pre keeps line structure and > markers quote',
		html: '<pre>Thanks, see below.\n\nOn Mon, 5 Oct 2026 at 10:00, Jonas Weber &lt;jonas@example.com&gt; wrote:\n&gt; Please send the deck.\n</pre>',
		expect: [
			['fresh', 'see below'],
			['quoted', 'send the deck', 'jonas@example.com'],
		],
	},
];
