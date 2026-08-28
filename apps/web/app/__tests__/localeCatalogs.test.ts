import { describe, expect, it } from 'vitest';
import { createI18n } from 'vue-i18n';
import de from '~~/i18n/locales/de.json';
import en from '~~/i18n/locales/en.json';

/**
 * Guards for the UI message catalogs (apps/web/i18n/locales).
 *
 * `en` is the source of truth and the `fallbackLocale`, so a translation that
 * drifts fails quietly at runtime — the visitor just gets an English line in the
 * middle of a German page. These checks turn every way that drift happens into a
 * test failure instead:
 *  - a key added to `en` and never translated (or a stale key left behind);
 *  - a placeholder renamed on one side only, which renders the literal `{name}`;
 *  - markup smuggled into a message, which @nuxtjs/i18n rejects at BUILD time
 *    (`compilation.strictMessage`) — a broken deploy, not a broken string;
 *  - a bare `@`, which the message compiler reads as a linked-message marker
 *    (email placeholders have to be written as `you{'@'}example.com`).
 */

type Catalog = { [key: string]: string | Catalog };

function flatten(catalog: Catalog, prefix = ''): Map<string, string> {
	const flat = new Map<string, string>();
	for (const [key, value] of Object.entries(catalog)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof value === 'string') {
			flat.set(path, value);
		} else {
			for (const [nested, message] of flatten(value, path)) flat.set(nested, message);
		}
	}
	return flat;
}

/** Named interpolations only — `{'@'}` and friends are literals, not params. */
function placeholders(message: string): string[] {
	return [...message.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((match) => match[1]!).sort();
}

const sources = { en: en as Catalog, de: de as Catalog };
const catalogs = { en: flatten(sources.en), de: flatten(sources.de) };
const localeCodes = Object.keys(catalogs) as (keyof typeof catalogs)[];

describe('UI message catalogs', () => {
	it.each(localeCodes.filter((code) => code !== 'en'))('%s covers every en key', (code) => {
		const missing = [...catalogs.en.keys()].filter((key) => !catalogs[code].has(key));
		const extra = [...catalogs[code].keys()].filter((key) => !catalogs.en.has(key));
		expect({ missing, extra }).toEqual({ missing: [], extra: [] });
	});

	it.each(localeCodes.filter((code) => code !== 'en'))('%s keeps every placeholder', (code) => {
		const drifted = [...catalogs.en].filter(([key, message]) => {
			const translated = catalogs[code].get(key);
			return translated != null && placeholders(translated).join() !== placeholders(message).join();
		});
		expect(drifted.map(([key]) => key)).toEqual([]);
	});

	it.each(localeCodes)('%s carries no markup and no unescaped @', (code) => {
		const offenders = [...catalogs[code]]
			.filter(([, message]) => /[<>]/.test(message) || /(?<!\{')@/.test(message))
			.map(([key]) => key);
		expect(offenders).toEqual([]);
	});

	/**
	 * A `de` message that is character-for-character its English source is almost
	 * always a key someone added to both files and translated in neither: the
	 * catalog-parity check above passes, the compile check passes, and the German
	 * page just says the English thing. The failure this catches is real — the
	 * whole `imprint.*` block sat here as untranslated GERMAN in `en.json`, so the
	 * English imprint page rendered "Angaben gemäß § 5 TMG".
	 *
	 * Ported from `packages/ui/__tests__/localeCatalogs.test.ts`, which has held
	 * the layer catalogs to this for a while; this app's catalog is 9,000 keys, so
	 * the legitimately-identical set is a list rather than a handful. Everything on
	 * it is a proper noun (Mailchimp, Twilio, OpenAI), a term German borrows
	 * wholesale (Spam, Marketing, Chat, Port), an IANA timezone or language name,
	 * or a placeholder that is the same in both.
	 */
	const INTENTIONALLY_IDENTICAL = new Set([
		'auth.register.inviteOnlyTitleAccent',
		'auth.register.nameLabel',
		'common.name',
		'common.optional',
		'common.status',
		'components.automations.steps.email.editor.templateOption',
		'components.autonomy.autonomyDemotionAlerts.incident',
		'components.autonomy.autonomyRuleEditor.categories.spam',
		'components.autonomy.autonomyRuleEditor.categories.support',
		'components.campaigns.commandRow.abBadge',
		'components.campaigns.steps.setupStep.optional',
		'components.channels.channelConfigCard.channels.chat.label',
		'components.channels.channelConfigCard.channels.sms.label',
		'components.channels.channelConfigCard.channels.whatsapp.label',
		'components.channels.channelConfigForm.fields.accountSid.label',
		'components.channels.channelConfigForm.fields.accountSid.placeholder',
		'components.channels.channelConfigForm.fields.endpointUrl.placeholder',
		'components.channels.channelConfigForm.fields.phoneNumber.placeholder',
		'components.channels.channelConfigForm.fields.secretKey.label',
		'components.chat.chatEditChannelDialog.optional',
		'components.chat.chatMemberList.admin',
		'components.chat.chatNewChannelDialog.optionalHint',
		'components.chat.chatSidebar.title',
		'components.conditions.contactProperty.editor.operator',
		'components.contacts.identitiesTab.identifierPlaceholder.phone',
		'components.contacts.integrationImportModal.configure.audienceListIdPlaceholder',
		'components.contacts.integrationImportModal.configure.mailchimpApiKeyPlaceholder',
		'components.contacts.integrationImportModal.configure.stripeSecretKeyPlaceholder',
		'components.contacts.integrationImportModal.providers.mailchimp.name',
		'components.contacts.integrationImportModal.providers.stripe.name',
		'components.contacts.suppressionNotice.detail',
		'components.contacts.timelineStatsCard.channels.chat',
		'components.contacts.timelineStatsCard.channels.sms',
		'components.contacts.timelineStatsCard.channels.whatsapp',
		'components.contacts.unifiedTimelineTab.channels.chat',
		'components.contacts.unifiedTimelineTab.channels.sms',
		'components.contacts.unifiedTimelineTab.channels.whatsapp',
		'components.dashboard.cards.accuracyTrend.details',
		'components.dashboard.cards.channelHealth.channels.chat',
		'components.dashboard.cards.channelHealth.channels.sms',
		'components.dashboard.cards.channelHealth.channels.whatsapp',
		'components.dashboard.cards.deliveryRates.details',
		'components.dashboard.dashboardEditor.roles.admin',
		'components.dashboard.dashboardEditor.sizes.large',
		'components.dashboard.dashboardEditor.sizes.medium',
		'components.dashboard.dashboardEditor.sizes.small',
		'components.dashboard.emailSendTimeline.errorCode',
		'components.dashboard.gettingStartedResources.urlPlaceholder',
		'components.delivery.complianceTelemetryCard.unsubscribe.milliseconds',
		'components.delivery.complianceTelemetryCard.unsubscribe.seconds',
		'components.delivery.deliverabilityRegressionAlerts.domain',
		'components.delivery.deliverabilityRegressionAlerts.statusLabel',
		'components.delivery.deliverabilitySetupValues.fields.domain',
		'components.delivery.deliverabilitySetupValues.fields.name',
		'components.delivery.deliverabilitySetupValues.fields.ttl',
		'components.delivery.domainTable.authAllPass',
		'components.delivery.independenceTrendChart.relay',
		'components.delivery.migrationImportStep.apiKeyPlaceholder',
		'components.delivery.migrationImportStep.carriedEntry',
		'components.delivery.migrationImportStep.listIdPlaceholder',
		'components.delivery.relayDomainStatus.dkimError',
		'components.delivery.relayDomainStatus.spfError',
		'components.delivery.transportConnectionWizard.optionalSuffix',
		'components.delivery.transportCredentialFields.port',
		'components.delivery.transportEditor.fromNamePlaceholder',
		'components.delivery.transportEditor.optionalSuffix',
		'components.desktop.desktopTitlebar.alphaBadge',
		'components.desktop.desktopTitlebar.postbox',
		'components.desktop.workspaceMenu.menuLabel',
		'components.domains.addDomainForm.returnPathOptional',
		'components.domains.addDomainForm.returnPathPlaceholder',
		'components.domains.addDomainForm.subdomainPlaceholder',
		'components.domains.dnsRecordPanel.hostName',
		'components.domains.dnsRecordPanel.rfc.dkim',
		'components.domains.dnsRecordPanel.rfc.dmarc',
		'components.domains.dnsRecordPanel.rfc.mtaSts',
		'components.domains.recordRow.devBadge',
		'components.domains.returnPathEditor.inputPlaceholder',
		'components.domains.streamSubdomainPlanPanel.dkimLabel',
		'components.domains.trackingDomainsSection.form.subdomainPlaceholder',
		'components.domains.trackingDomainsSection.recordLabel',
		'components.email.emailSubjectSettingsCard.emailTypes.marketing',
		'components.email.emailSubjectSettingsCard.languageOption',
		'components.files.fileCard.sources.upload',
		'components.files.fileUploadModal.tagsLabel',
		'components.forms.fieldsEditor.types.text',
		'components.inbox.inboxThreadRow.channel.sms',
		'components.inbox.inboxThreadRow.channel.whatsapp',
		'components.keyboardShortcutsHelp.sections.navigation',
		'components.knowledge.graphStatsPanel.bucketHint',
		'components.knowledge.graphStatsPanel.communityCount',
		'components.knowledge.graphStatsPanel.median',
		'components.knowledge.knowledgeEntryCard.sourceTypes.chat',
		'components.knowledge.knowledgeEntryForm.sourceTypes.chat',
		'components.knowledge.knowledgeEntryForm.tags',
		'components.knowledge.relationsList.count',
		'components.postbox.postboxCoachPanel.suggestionCategory',
		'components.postbox.postboxComposerEnvelope.bcc',
		'components.postbox.postboxComposerEnvelope.cc',
		'components.postbox.postboxEditorToolbar.link',
		'components.postbox.postboxEmojiPicker.listLabel',
		'components.postbox.postboxFilterRuleBuilder.fields.cc',
		'components.postbox.postboxFilterRuleBuilder.fields.header',
		'components.postbox.postboxFilterRuleBuilder.headerNamePlaceholder',
		'components.postbox.postboxFilterRuleBuilder.sizePlaceholder',
		'components.postbox.postboxFolderList.roles.spam',
		'components.postbox.postboxFolderRail.labelsHeading',
		'components.postbox.postboxLayout.escKey',
		'components.postbox.postboxLayout.folderRoles.spam',
		'components.postbox.postboxMailboxConnectForm.ssl',
		// Protocol names and RFC header field names — the same words in both
		// locales, and translating them would stop them matching the raw message.
		'components.postbox.postboxMessageDetails.arc',
		'components.postbox.postboxMessageDetails.dkim',
		'components.postbox.postboxMessageDetails.dmarc',
		'components.postbox.postboxMessageDetails.messageId',
		'components.postbox.postboxMessageDetails.returnPath',
		'components.postbox.postboxMessageDetails.spf',
		'components.postbox.postboxMailboxSwitcher.personal.title',
		'components.postbox.postboxMailboxSwitcher.team.heading',
		'components.postbox.postboxQuickActionsBar.label',
		'components.postbox.postboxQuickActionsBar.spam',
		'components.postbox.postboxRewritePreview.original',
		'components.postbox.postboxSenderControls.vipOperation',
		// A bare unit suffix on a number ("30s") — same in both languages.
		'components.postbox.postboxSendingSettings.undoSendSeconds',
		'components.postbox.postboxTodayView.forYouDetail',
		'components.postbox.postboxVoiceProfileCard.emoji',
		'components.postbox.postboxVoiceProfileCard.outOfFive',
		'components.postbox.teamInboxMembersPanel.memberOption',
		'components.preferences.preferencesAppearance.system.label',
		'components.query.sourceCitation.knowledgeTooltip',
		'components.settings.connectedApps.connectedAppRegisterModal.endpointPlaceholder',
		'components.settings.connectedApps.connectedAppRegisterModal.pluginLabel',
		'components.settings.connectedApps.connectedAppSecretReveal.appLabel',
		'components.settings.team.inviteModal.displayNamePlaceholder',
		'components.settings.team.inviteModal.localpartPlaceholder',
		'components.translation.cell.htmlBadge',
		'components.translation.manager.buttonBlock',
		'components.translation.manager.containerPrefix',
		'components.translation.manager.htmlBadge',
		'components.translation.manager.languageOption',
		'components.webhooks.webhookDeliveryLogsPanel.events.test',
		'dashboard.admin.backups.pageTitle',
		'dashboard.admin.backups.title',
		'dashboard.admin.delivery.advanced.independence.pageTitle',
		'dashboard.admin.delivery.providerRouting.editModal.title',
		'dashboard.admin.delivery.transport.config.listSeparator',
		'dashboard.admin.delivery.webhooks.pageTitle',
		'dashboard.admin.delivery.webhooks.title',
		'dashboard.admin.index.eyebrow',
		'dashboard.admin.index.pageTitle',
		'dashboard.admin.index.platformAreas.backups.title',
		'dashboard.admin.instance.aiProvider.embeddings.title',
		'dashboard.admin.instance.emailTheme.fonts.arial',
		'dashboard.admin.instance.emailTheme.fonts.courierNew',
		'dashboard.admin.instance.emailTheme.fonts.georgia',
		'dashboard.admin.instance.emailTheme.fonts.helvetica',
		'dashboard.admin.instance.emailTheme.fonts.timesNewRoman',
		'dashboard.admin.instance.emailTheme.fonts.trebuchetMs',
		'dashboard.admin.instance.emailTheme.fonts.verdana',
		'dashboard.admin.instance.emailTheme.px',
		'dashboard.admin.instance.features.packs.flags',
		'dashboard.admin.instance.general.timezones.americaAnchorage',
		'dashboard.admin.instance.general.timezones.americaPhoenix',
		'dashboard.admin.instance.general.timezones.asiaDubai',
		'dashboard.admin.instance.general.timezones.asiaSeoul',
		'dashboard.admin.instance.general.timezones.australiaBrisbane',
		'dashboard.admin.instance.general.timezones.australiaMelbourne',
		'dashboard.admin.instance.general.timezones.australiaPerth',
		'dashboard.admin.instance.general.timezones.australiaSydney',
		'dashboard.admin.instance.general.timezones.europeAmsterdam',
		'dashboard.admin.instance.general.timezones.europeBerlin',
		'dashboard.admin.instance.general.timezones.europeLondon',
		'dashboard.admin.instance.general.timezones.europeMadrid',
		'dashboard.admin.instance.general.timezones.europeParis',
		'dashboard.admin.instance.general.timezones.europeStockholm',
		'dashboard.admin.instance.general.timezones.pacificAuckland',
		'dashboard.admin.instance.general.timezones.pacificHonolulu',
		'dashboard.admin.instance.general.timezones.utc',
		'dashboard.admin.instance.index.groups.plugins.title',
		'dashboard.admin.instance.plugins.detail.packageVersion',
		'dashboard.admin.instance.plugins.detail.pageTitle',
		'dashboard.admin.instance.plugins.detail.settings.secretLabelSuffix',
		'dashboard.admin.instance.plugins.index.packageVersion',
		'dashboard.admin.instance.plugins.index.pageTitle',
		'dashboard.admin.instance.plugins.index.title',
		'dashboard.admin.instance.properties.fields.keyFallback',
		'dashboard.admin.instance.properties.types.string.label',
		'dashboard.admin.instance.sealedMail.pageTitle',
		'dashboard.admin.instance.sealedMail.title',
		'dashboard.admin.operator.index.addAdminModal.userOption',
		'dashboard.admin.operator.index.roleOptions.admin',
		'dashboard.admin.operator.index.roleOptions.superadmin',
		'dashboard.admin.operator.index.tabs.admins',
		'dashboard.admin.operator.index.tabs.organizations',
		'dashboard.admin.operator.index.workspaces.title',
		'dashboard.admin.system.index.duration.minutes',
		'dashboard.admin.system.index.duration.seconds',
		'dashboard.admin.system.index.pageTitle',
		'dashboard.admin.system.index.title',
		'dashboard.admin.team.api.index.rateLimit.headerColumn',
		'dashboard.audience.contacts.detail.details',
		'dashboard.audience.contacts.index.importMenu.integrationsDescription',
		'dashboard.audience.segments.detail.index.pageTitle',
		'dashboard.automations.detail.edit.activateDialog.automation',
		'dashboard.automations.detail.index.runs.range',
		'dashboard.automations.new.form.optionalHint',
		'dashboard.campaigns.detail.edit.details.optionalSuffix',
		'dashboard.campaigns.new.audience.segment',
		'dashboard.chat.detail.pageTitle',
		'dashboard.chat.detail.pageTitleForRoom',
		'dashboard.chat.index.pageTitle',
		'dashboard.files.detail.details',
		'dashboard.files.detail.tags',
		'dashboard.files.index.size.bytes',
		'dashboard.files.index.size.kilobytes',
		'dashboard.files.index.size.megabytes',
		'dashboard.files.index.sourceBadge.upload',
		'dashboard.files.index.sources.uploads',
		'dashboard.inbox.activity.channelHealthTitle',
		'dashboard.inbox.activity.channels.chat',
		'dashboard.inbox.activity.channels.sms',
		'dashboard.inbox.activity.channels.whatsapp',
		'dashboard.inbox.detail.details',
		'dashboard.inbox.detail.priorities.normal',
		'dashboard.inbox.detail.sentiments.neutral',
		'dashboard.index.pageTitle',
		'dashboard.knowledge.detail.details',
		'dashboard.knowledge.detail.sourceTypes.chat',
		'dashboard.postbox.contacts.emailPlaceholder',
		'dashboard.preferences.addAccount.addressPlaceholderPersonal',
		'dashboard.preferences.addAccount.addressPlaceholderTeam',
		'dashboard.preferences.addAccount.displayNamePlaceholderPersonal',
		'dashboard.preferences.addAccount.displayNamePlaceholderTeam',
		'dashboard.preferences.aliases.aliasPlaceholder',
		'dashboard.preferences.appPasswords.imapLabel',
		'dashboard.preferences.appPasswords.imapValue',
		'dashboard.preferences.appPasswords.labelPlaceholder',
		'dashboard.preferences.appPasswords.smtpLabel',
		'dashboard.preferences.appPasswords.smtpValue',
		'dashboard.preferences.forwarding.addressPlaceholder',
		'dashboard.preferences.index.displayNamePlaceholder',
		// Browser and OS names are product names; German uses them verbatim. Only
		// the two `unknown` fallbacks in those blocks are prose, and both ARE
		// translated — which is what keeps this run of entries honest.
		'dashboard.preferences.security.device.browsers.chrome',
		'dashboard.preferences.security.device.browsers.edge',
		'dashboard.preferences.security.device.browsers.firefox',
		'dashboard.preferences.security.device.browsers.opera',
		'dashboard.preferences.security.device.browsers.safari',
		'dashboard.preferences.security.device.platforms.android',
		'dashboard.preferences.security.device.platforms.chromeOs',
		'dashboard.preferences.security.device.platforms.ios',
		'dashboard.preferences.security.device.platforms.ipados',
		'dashboard.preferences.security.device.platforms.linux',
		'dashboard.preferences.security.device.platforms.macos',
		'dashboard.preferences.security.device.platforms.windows',
		// "IP {address}" — the abbreviation and the placeholder, nothing else.
		'dashboard.preferences.security.sessions.ipLabel',
		'dashboard.preferences.signatures.bodyPlaceholder',
		'dashboard.send.blocks.index.sort.name',
		'dashboard.send.emails.detail.settings.languageWithNative',
		'dashboard.send.index.stats.marketing',
		'dashboard.send.marketing.index.sort.nameAsc',
		'dashboard.send.marketing.index.sort.nameDesc',
		'dashboard.send.media.tags',
		'dashboard.send.media.types.audio',
		'dashboard.send.media.types.pdf',
		'dashboard.send.media.types.video',
		'dashboard.send.transactional.index.columns.slug',
		'dashboard.send.transactional.index.create.slugLabel',
		'desktop.settings.globalHeading',
		'desktop.settings.theme.system',
		'desktop.settings.updates.title',
		'desktop.settings.updates.version',
		'desktop.settings.workspaces.heading',
		'desktop.setup.ai.openai',
		'desktop.setup.ai.openrouter',
		'desktop.setup.domain.placeholder',
		'desktop.setup.domain.placeholderRequired',
		'desktop.setup.fields.branch',
		'desktop.setup.fields.port',
		'desktop.setup.packs.marketing',
		'desktop.setup.sending.resend',
		'desktop.setup.sending.ses',
		'desktop.setup.steps.domain',
		'recipient.archive.seoTitleLoaded',
		'recipient.share.seoTitleLoaded',
		'setup.admin.displayNamePlaceholder',
		'setup.email.fromIdentityOptional',
		'setup.email.providers.emailit.label',
		'setup.email.providers.mandrill.label',
		'setup.email.providers.resend.label',
		'setup.email.providers.ses.label',
		'setup.email.sesRegionLabel',
		'setup.email.smtpPortLabel',
		'setup.review.adminName',
		'setup.team.brand',
		'shared.aiProviders.providers.anthropic.label',
		'shared.aiProviders.providers.azure.label',
		'shared.aiProviders.providers.google.label',
		'shared.aiProviders.providers.openai.label',
		'shared.aiProviders.providers.openrouter.label',
		'shared.automations.steps.email.templateName',
		'shared.breadcrumbPatterns.pages.label',
		'shared.breadcrumbPatterns.subsections.marketing',
		'shared.breadcrumbPatterns.subsections.plugins',
		'shared.breadcrumbRoutes.pages.backups',
		'shared.breadcrumbRoutes.pages.marketing',
		'shared.breadcrumbRoutes.pages.plugins',
		'shared.breadcrumbRoutes.pages.systemAndUpdates',
		'shared.breadcrumbRoutes.pages.webhooks',
		'shared.breadcrumbRoutes.sections.dashboard',
		'shared.channelKinds.addable.sms',
		'shared.channelKinds.addable.whatsapp',
		'shared.dashboardNavigation.items.assistant.chat',
		'shared.dashboardNavigation.items.knowledge.explorer',
		'shared.dashboardNavigation.items.knowledge.graph',
		'shared.dashboardNavigation.items.postbox.spam',
		'shared.dashboardNavigation.sections.chat',
		'shared.dashboardNavigation.sections.postbox',
		'shared.data.languageOptions.languages.hi',
		'shared.data.languageOptions.timezones.americaAnchorage',
		'shared.data.languageOptions.timezones.americaChicago',
		'shared.data.languageOptions.timezones.americaDenver',
		'shared.data.languageOptions.timezones.americaLosAngeles',
		'shared.data.languageOptions.timezones.americaNewYork',
		'shared.data.languageOptions.timezones.asiaDubai',
		'shared.data.languageOptions.timezones.asiaShanghai',
		'shared.data.languageOptions.timezones.australiaMelbourne',
		'shared.data.languageOptions.timezones.australiaSydney',
		'shared.data.languageOptions.timezones.europeLondon',
		'shared.data.languageOptions.timezones.pacificHonolulu',
		'shared.data.marketingTemplatePresets.newsletter.name',
		'shared.deliverabilityMeasurement.provider.apple',
		'shared.deliverabilityMeasurement.provider.gmail',
		'shared.deliverabilityMeasurement.provider.microsoft',
		'shared.deliverabilityMeasurement.provider.yahoo',
		'shared.desktop.provisioning.subdomainFields.convex.label',
		'shared.desktop.provisioning.subdomainFields.site.label',
		'shared.desktop.provisioningForm.password.ok',
		'shared.mailAutodiscover.provider.fastmail.hint',
		'shared.mailAutodiscover.provider.fastmail.name',
		'shared.mailAutodiscover.provider.gmail.name',
		'shared.mailAutodiscover.provider.icloud.name',
		'shared.mailAutodiscover.provider.outlook.name',
		'shared.mailAutodiscover.provider.yahoo.hint',
		'shared.mailAutodiscover.provider.yahoo.name',
		'shared.mandrillRelayStatus.outstanding.dkim',
		'shared.mandrillRelayStatus.outstanding.spf',
		'shared.postbox.usePostboxCommandSurface.groups.labels',
		'shared.postbox.usePostboxCommandSurface.groups.postbox',
		'shared.postbox.usePostboxThreadCategories.options.newsletter',
		'shared.postbox.usePostboxThreadCategories.options.person',
		'shared.postboxShortcuts.groups.navigation',
		'shared.postboxShortcuts.groups.triage',
		'shared.relayDomainDisplay.outstanding.dkim',
		'shared.relayDomainDisplay.outstanding.spf',
		'shared.settingsRegistry.controls.workspaces.title',
		'shared.teamRoles.admin.label',
		'shared.transportState.labels.mandrill',
		'shared.transportWizard.checks.dkim',
		'shared.transportWizard.checks.dmarc',
		'shared.transportWizard.checks.spf',
		'shared.useAuditLogPresentation.actionGroups.apiAndWebhooks',
		'shared.useAuditLogPresentation.actionGroups.plugins',
		'shared.useAuditLogPresentation.actionGroups.postbox',
		'shared.useAuditLogPresentation.hostedPluginDetail.pluginAndOperation',
		'shared.useAuditLogPresentation.resourceFilters.domain',
		'shared.useAuditLogPresentation.resourceFilters.plugin',
		'shared.useAuditLogPresentation.resourceFilters.webhook',
		'shared.useAuditLogPresentation.resources.automation',
		'shared.useAuditLogPresentation.resources.domain',
		'shared.useAuditLogPresentation.resources.plugin',
		'shared.useAuditLogPresentation.resources.segment',
		'shared.useAuditLogPresentation.resources.webhook',
		'shared.useCampaignForm.audience.segment',
		'shared.useCampaignForm.audience.segmentFallback',
		'shared.useCampaignForm.languages.hi',
		'shared.useContactIdentities.channels.linkedin',
		'shared.useContactIdentities.channels.twitter',
		'shared.useContactIdentities.channels.whatsapp',
		'shared.useTransactionalList.sort.nameAsc',
		'shared.useTransactionalList.sort.nameDesc',
		'sharedPkg.featureFlags.flags.chat.label',
		'sharedPkg.featureFlags.packs.marketing.label',
		'sharedPkg.sendProviderCatalog.credentialFields.ses.region.label',
		'sharedPkg.snoozePresets.sub.time',
		'sharedPkg.snoozePresets.sub.weekday',
		'shell.dashboard.alphaBadge',
		'shell.dashboard.contexts.marketing',
		'shell.dashboard.dashboardTooltip',
		'welcome.freshStart.optional',
	]);

	it('translates every message away from English', () => {
		const untranslated = [...catalogs.en]
			.filter(([key, message]) => catalogs.de.get(key) === message)
			.map(([key]) => key)
			.filter((key) => !INTENTIONALLY_IDENTICAL.has(key));
		expect(untranslated).toEqual([]);
	});

	/**
	 * The allowlist is a guard only while it is exact. An entry that outlives the
	 * key it excused — because the message was translated, renamed or deleted —
	 * silently re-opens the hole for whatever takes that key path next.
	 */
	it('carries no stale entry in the identical-by-design list', () => {
		const stale = [...INTENTIONALLY_IDENTICAL].filter(
			(key) => catalogs.en.get(key) !== catalogs.de.get(key)
		);
		expect(stale).toEqual([]);
	});

	// The catalogs are compiled by @nuxtjs/i18n at build time, so a message the
	// compiler chokes on is a failed deploy — and one it accepts but that leaks a
	// `{placeholder}` is a visible defect on a page a stranger reads.
	it.each(localeCodes)('%s compiles and interpolates every message', (code) => {
		const i18n = createI18n({ legacy: false, locale: code, messages: { [code]: sources[code] } });
		const broken: string[] = [];
		for (const [key, message] of catalogs[code]) {
			const params = Object.fromEntries(placeholders(message).map((name) => [name, 'X']));
			let rendered: string;
			try {
				rendered = i18n.global.t(key, params);
			} catch (error) {
				broken.push(`${key}: ${(error as Error).message}`);
				continue;
			}
			if (!rendered || rendered === key || /[{}]/.test(rendered)) {
				broken.push(`${key}: ${rendered}`);
			}
		}
		expect(broken).toEqual([]);
	});
});
