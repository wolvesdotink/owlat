# Screen inventory and review coverage

All 136 page components were included in the route/source inventory. The implementation targets repeated UI issues in their shared controls, page headers, empty states, and layout shells rather than making arbitrary changes to every file.

The browser sweep exercised 108 route/state cases across the main inventory and additional static routes. Fixture coverage is strongest for Mail, Team Inbox, settings, and team administration. Other screens can be empty or show a missing-record state because the existing local fixture pack does not seed campaigns, contacts, automations, or templates. Public token flows and native desktop behavior need their real runtime/data for complete end-to-end visual review. The comparison gallery deliberately uses screens that rendered with useful content.

| Page component | Review / change scope |
| --- | --- |
| [access-request.vue](../../apps/web/app/pages/access-request.vue) | Shared controls where used; public-page hierarchy retained. Token-dependent outcomes need real tokens. |
| [archive.vue](../../apps/web/app/pages/archive.vue) | Shared controls where used; public-page hierarchy retained. Token-dependent outcomes need real tokens. |
| [auth/forgot-password.vue](../../apps/web/app/pages/auth/forgot-password.vue) | Compact inputs; large authentication actions retained; dark-mode logo contrast. |
| [auth/login.vue](../../apps/web/app/pages/auth/login.vue) | Compact inputs; large authentication actions retained; dark-mode logo contrast. |
| [auth/register.vue](../../apps/web/app/pages/auth/register.vue) | Compact inputs; large authentication actions retained; dark-mode logo contrast. |
| [auth/reset-password.vue](../../apps/web/app/pages/auth/reset-password.vue) | Compact inputs; large authentication actions retained; dark-mode logo contrast. |
| [cancel-deletion.vue](../../apps/web/app/pages/cancel-deletion.vue) | Shared controls where used; public-page hierarchy retained. Token-dependent outcomes need real tokens. |
| [compose.vue](../../apps/web/app/pages/compose.vue) | Shared controls where used; public-page hierarchy retained. Token-dependent outcomes need real tokens. |
| [confirm.vue](../../apps/web/app/pages/confirm.vue) | Shared controls where used; public-page hierarchy retained. Token-dependent outcomes need real tokens. |
| [dashboard/admin/backups.vue](../../apps/web/app/pages/dashboard/admin/backups.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/delivery/advanced/cells.vue](../../apps/web/app/pages/dashboard/admin/delivery/advanced/cells.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/delivery/advanced/controls.vue](../../apps/web/app/pages/dashboard/admin/delivery/advanced/controls.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/delivery/advanced/independence.vue](../../apps/web/app/pages/dashboard/admin/delivery/advanced/independence.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/delivery/advanced/measurement.vue](../../apps/web/app/pages/dashboard/admin/delivery/advanced/measurement.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/delivery/deliverability.vue](../../apps/web/app/pages/dashboard/admin/delivery/deliverability.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/delivery/domains.vue](../../apps/web/app/pages/dashboard/admin/delivery/domains.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/delivery/index.vue](../../apps/web/app/pages/dashboard/admin/delivery/index.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/delivery/migrate.vue](../../apps/web/app/pages/dashboard/admin/delivery/migrate.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/delivery/provider-routing.vue](../../apps/web/app/pages/dashboard/admin/delivery/provider-routing.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/delivery/transport.vue](../../apps/web/app/pages/dashboard/admin/delivery/transport.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/delivery/webhooks.vue](../../apps/web/app/pages/dashboard/admin/delivery/webhooks.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/index.vue](../../apps/web/app/pages/dashboard/admin/index.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/instance/agent-health.vue](../../apps/web/app/pages/dashboard/admin/instance/agent-health.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/instance/agent.vue](../../apps/web/app/pages/dashboard/admin/instance/agent.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/instance/ai-provider.vue](../../apps/web/app/pages/dashboard/admin/instance/ai-provider.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/instance/autonomy.vue](../../apps/web/app/pages/dashboard/admin/instance/autonomy.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/instance/channels.vue](../../apps/web/app/pages/dashboard/admin/instance/channels.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/instance/email-theme.vue](../../apps/web/app/pages/dashboard/admin/instance/email-theme.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/instance/features.vue](../../apps/web/app/pages/dashboard/admin/instance/features.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/instance/forms.vue](../../apps/web/app/pages/dashboard/admin/instance/forms.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/instance/general.vue](../../apps/web/app/pages/dashboard/admin/instance/general.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/instance/index.vue](../../apps/web/app/pages/dashboard/admin/instance/index.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/instance/plugins/[id].vue](../../apps/web/app/pages/dashboard/admin/instance/plugins/[id].vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/instance/plugins/index.vue](../../apps/web/app/pages/dashboard/admin/instance/plugins/index.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/instance/properties.vue](../../apps/web/app/pages/dashboard/admin/instance/properties.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/instance/sealed-mail.vue](../../apps/web/app/pages/dashboard/admin/instance/sealed-mail.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/operator/index.vue](../../apps/web/app/pages/dashboard/admin/operator/index.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/system/index.vue](../../apps/web/app/pages/dashboard/admin/system/index.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/team/api/docs.vue](../../apps/web/app/pages/dashboard/admin/team/api/docs.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/team/api/index.vue](../../apps/web/app/pages/dashboard/admin/team/api/index.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/team/audit.vue](../../apps/web/app/pages/dashboard/admin/team/audit.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/team/connected-apps/index.vue](../../apps/web/app/pages/dashboard/admin/team/connected-apps/index.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/team/inboxes.vue](../../apps/web/app/pages/dashboard/admin/team/inboxes.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/team/senders.vue](../../apps/web/app/pages/dashboard/admin/team/senders.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/admin/team.vue](../../apps/web/app/pages/dashboard/admin/team.vue) | Administration tree in the single sidebar; compact actions and form controls. |
| [dashboard/assistant/index.vue](../../apps/web/app/pages/dashboard/assistant/index.vue) | Conversation navigation in the single sidebar; compact actions; mobile drawers retained. |
| [dashboard/audience/contacts/[id].vue](../../apps/web/app/pages/dashboard/audience/contacts/[id].vue) | Shared header/actions and empty/error presentation; populated detail/editor fixture unavailable. |
| [dashboard/audience/contacts/index.vue](../../apps/web/app/pages/dashboard/audience/contacts/index.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/audience/index.vue](../../apps/web/app/pages/dashboard/audience/index.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/audience/segments/[id]/index.vue](../../apps/web/app/pages/dashboard/audience/segments/[id]/index.vue) | Shared header/actions and empty/error presentation; populated detail/editor fixture unavailable. |
| [dashboard/audience/segments/index.vue](../../apps/web/app/pages/dashboard/audience/segments/index.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/audience/suppressions.vue](../../apps/web/app/pages/dashboard/audience/suppressions.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/audience/topics/[id]/contacts/[contactId].vue](../../apps/web/app/pages/dashboard/audience/topics/[id]/contacts/[contactId].vue) | Shared header/actions and empty/error presentation; populated detail/editor fixture unavailable. |
| [dashboard/audience/topics/[id]/index.vue](../../apps/web/app/pages/dashboard/audience/topics/[id]/index.vue) | Shared header/actions and empty/error presentation; populated detail/editor fixture unavailable. |
| [dashboard/audience/topics/index.vue](../../apps/web/app/pages/dashboard/audience/topics/index.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/automations/[id]/edit.vue](../../apps/web/app/pages/dashboard/automations/[id]/edit.vue) | Shared header/actions and empty/error presentation; populated detail/editor fixture unavailable. |
| [dashboard/automations/[id]/index.vue](../../apps/web/app/pages/dashboard/automations/[id]/index.vue) | Shared header/actions and empty/error presentation; populated detail/editor fixture unavailable. |
| [dashboard/automations/index.vue](../../apps/web/app/pages/dashboard/automations/index.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/automations/new.vue](../../apps/web/app/pages/dashboard/automations/new.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/campaigns/[id]/edit.vue](../../apps/web/app/pages/dashboard/campaigns/[id]/edit.vue) | Shared header/actions and empty/error presentation; populated detail/editor fixture unavailable. |
| [dashboard/campaigns/[id]/report.vue](../../apps/web/app/pages/dashboard/campaigns/[id]/report.vue) | Shared header/actions and empty/error presentation; populated detail/editor fixture unavailable. |
| [dashboard/campaigns/[id]/sends/[sendId].vue](../../apps/web/app/pages/dashboard/campaigns/[id]/sends/[sendId].vue) | Shared header/actions and empty/error presentation; populated detail/editor fixture unavailable. |
| [dashboard/campaigns/index.vue](../../apps/web/app/pages/dashboard/campaigns/index.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/campaigns/new.vue](../../apps/web/app/pages/dashboard/campaigns/new.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/chat/[roomId].vue](../../apps/web/app/pages/dashboard/chat/[roomId].vue) | Conversation navigation in the single sidebar; compact actions; mobile drawers retained. |
| [dashboard/chat/index.vue](../../apps/web/app/pages/dashboard/chat/index.vue) | Conversation navigation in the single sidebar; compact actions; mobile drawers retained. |
| [dashboard/files/[id].vue](../../apps/web/app/pages/dashboard/files/[id].vue) | Shared header/actions and empty/error presentation; populated detail/editor fixture unavailable. |
| [dashboard/files/index.vue](../../apps/web/app/pages/dashboard/files/index.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/inbox/[threadId].vue](../../apps/web/app/pages/dashboard/inbox/[threadId].vue) | Shared header/actions and empty/error presentation; populated detail/editor fixture unavailable. |
| [dashboard/inbox/activity.vue](../../apps/web/app/pages/dashboard/inbox/activity.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/inbox/code-tasks.vue](../../apps/web/app/pages/dashboard/inbox/code-tasks.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/inbox/failed.vue](../../apps/web/app/pages/dashboard/inbox/failed.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/inbox/index.vue](../../apps/web/app/pages/dashboard/inbox/index.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/inbox/quarantine.vue](../../apps/web/app/pages/dashboard/inbox/quarantine.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/inbox/review.vue](../../apps/web/app/pages/dashboard/inbox/review.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/index.vue](../../apps/web/app/pages/dashboard/index.vue) | Denser app navigation; two-column setup checklist on wide screens; aligned compose split button. |
| [dashboard/knowledge/[id].vue](../../apps/web/app/pages/dashboard/knowledge/[id].vue) | Shared header/actions and empty/error presentation; populated detail/editor fixture unavailable. |
| [dashboard/knowledge/graph.vue](../../apps/web/app/pages/dashboard/knowledge/graph.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/knowledge/index.vue](../../apps/web/app/pages/dashboard/knowledge/index.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/postbox/[folder]/[messageId].vue](../../apps/web/app/pages/dashboard/postbox/[folder]/[messageId].vue) | Mail controls and shared shell; Browse folds its folder rail into the shell. Utility pages retain their existing content. |
| [dashboard/postbox/[folder]/index.vue](../../apps/web/app/pages/dashboard/postbox/[folder]/index.vue) | Mail controls and shared shell; Browse folds its folder rail into the shell. Utility pages retain their existing content. |
| [dashboard/postbox/contacts.vue](../../apps/web/app/pages/dashboard/postbox/contacts.vue) | Mail controls and shared shell; Browse folds its folder rail into the shell. Utility pages retain their existing content. |
| [dashboard/postbox/files.vue](../../apps/web/app/pages/dashboard/postbox/files.vue) | Mail controls and shared shell; Browse folds its folder rail into the shell. Utility pages retain their existing content. |
| [dashboard/postbox/index.vue](../../apps/web/app/pages/dashboard/postbox/index.vue) | Mail controls and shared shell; Browse folds its folder rail into the shell. Utility pages retain their existing content. |
| [dashboard/postbox/label/[labelId].vue](../../apps/web/app/pages/dashboard/postbox/label/[labelId].vue) | Mail controls and shared shell; Browse folds its folder rail into the shell. Utility pages retain their existing content. |
| [dashboard/postbox/migrate.vue](../../apps/web/app/pages/dashboard/postbox/migrate.vue) | Mail controls and shared shell; Browse folds its folder rail into the shell. Utility pages retain their existing content. |
| [dashboard/postbox/reply-queue.vue](../../apps/web/app/pages/dashboard/postbox/reply-queue.vue) | Mail controls and shared shell; Browse folds its folder rail into the shell. Utility pages retain their existing content. |
| [dashboard/postbox/search.vue](../../apps/web/app/pages/dashboard/postbox/search.vue) | Mail controls and shared shell; Browse folds its folder rail into the shell. Utility pages retain their existing content. |
| [dashboard/postbox/subscriptions.vue](../../apps/web/app/pages/dashboard/postbox/subscriptions.vue) | Mail controls and shared shell; Browse folds its folder rail into the shell. Utility pages retain their existing content. |
| [dashboard/preferences/account.vue](../../apps/web/app/pages/dashboard/preferences/account.vue) | Preferences tree in the single sidebar; compact form controls and stable layout transitions. |
| [dashboard/preferences/add-account.vue](../../apps/web/app/pages/dashboard/preferences/add-account.vue) | Preferences tree in the single sidebar; compact form controls and stable layout transitions. |
| [dashboard/preferences/aliases.vue](../../apps/web/app/pages/dashboard/preferences/aliases.vue) | Preferences tree in the single sidebar; compact form controls and stable layout transitions. |
| [dashboard/preferences/app-passwords.vue](../../apps/web/app/pages/dashboard/preferences/app-passwords.vue) | Preferences tree in the single sidebar; compact form controls and stable layout transitions. |
| [dashboard/preferences/device.vue](../../apps/web/app/pages/dashboard/preferences/device.vue) | Preferences tree in the single sidebar; compact form controls and stable layout transitions. |
| [dashboard/preferences/external-account.vue](../../apps/web/app/pages/dashboard/preferences/external-account.vue) | Preferences tree in the single sidebar; compact form controls and stable layout transitions. |
| [dashboard/preferences/filters.vue](../../apps/web/app/pages/dashboard/preferences/filters.vue) | Preferences tree in the single sidebar; compact form controls and stable layout transitions. |
| [dashboard/preferences/forwarding.vue](../../apps/web/app/pages/dashboard/preferences/forwarding.vue) | Preferences tree in the single sidebar; compact form controls and stable layout transitions. |
| [dashboard/preferences/index.vue](../../apps/web/app/pages/dashboard/preferences/index.vue) | Preferences tree in the single sidebar; compact form controls and stable layout transitions. |
| [dashboard/preferences/members/[mailboxId].vue](../../apps/web/app/pages/dashboard/preferences/members/[mailboxId].vue) | Preferences tree in the single sidebar; compact form controls and stable layout transitions. |
| [dashboard/preferences/security.vue](../../apps/web/app/pages/dashboard/preferences/security.vue) | Preferences tree in the single sidebar; compact form controls and stable layout transitions. |
| [dashboard/preferences/signatures.vue](../../apps/web/app/pages/dashboard/preferences/signatures.vue) | Preferences tree in the single sidebar; compact form controls and stable layout transitions. |
| [dashboard/preferences/snippets.vue](../../apps/web/app/pages/dashboard/preferences/snippets.vue) | Preferences tree in the single sidebar; compact form controls and stable layout transitions. |
| [dashboard/preferences/vacation.vue](../../apps/web/app/pages/dashboard/preferences/vacation.vue) | Preferences tree in the single sidebar; compact form controls and stable layout transitions. |
| [dashboard/preferences/writing-voice.vue](../../apps/web/app/pages/dashboard/preferences/writing-voice.vue) | Preferences tree in the single sidebar; compact form controls and stable layout transitions. |
| [dashboard/send/blocks/[id]/edit.vue](../../apps/web/app/pages/dashboard/send/blocks/[id]/edit.vue) | Shared header/actions and empty/error presentation; populated detail/editor fixture unavailable. |
| [dashboard/send/blocks/index.vue](../../apps/web/app/pages/dashboard/send/blocks/index.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/send/emails/[id]/edit.vue](../../apps/web/app/pages/dashboard/send/emails/[id]/edit.vue) | Shared header/actions and empty/error presentation; populated detail/editor fixture unavailable. |
| [dashboard/send/emails/[id]/settings.vue](../../apps/web/app/pages/dashboard/send/emails/[id]/settings.vue) | Shared header/actions and empty/error presentation; populated detail/editor fixture unavailable. |
| [dashboard/send/emails/[id]/translations.vue](../../apps/web/app/pages/dashboard/send/emails/[id]/translations.vue) | Shared header/actions and empty/error presentation; populated detail/editor fixture unavailable. |
| [dashboard/send/index.vue](../../apps/web/app/pages/dashboard/send/index.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/send/marketing/index.vue](../../apps/web/app/pages/dashboard/send/marketing/index.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/send/media.vue](../../apps/web/app/pages/dashboard/send/media.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/send/transactional/[id]/edit.vue](../../apps/web/app/pages/dashboard/send/transactional/[id]/edit.vue) | Shared header/actions and empty/error presentation; populated detail/editor fixture unavailable. |
| [dashboard/send/transactional/[id]/sends/[sendId].vue](../../apps/web/app/pages/dashboard/send/transactional/[id]/sends/[sendId].vue) | Shared header/actions and empty/error presentation; populated detail/editor fixture unavailable. |
| [dashboard/send/transactional/[id]/translations.vue](../../apps/web/app/pages/dashboard/send/transactional/[id]/translations.vue) | Shared header/actions and empty/error presentation; populated detail/editor fixture unavailable. |
| [dashboard/send/transactional/index.vue](../../apps/web/app/pages/dashboard/send/transactional/index.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [dashboard/visualizations.vue](../../apps/web/app/pages/dashboard/visualizations.vue) | Compact page actions, aligned fields, quieter shared headers/empty states, and denser app navigation. |
| [desktop/connect.vue](../../apps/web/app/pages/desktop/connect.vue) | Shared controls reviewed in source; native window behavior is outside the browser fixture review. |
| [desktop/settings.vue](../../apps/web/app/pages/desktop/settings.vue) | Shared controls reviewed in source; native window behavior is outside the browser fixture review. |
| [desktop/setup.vue](../../apps/web/app/pages/desktop/setup.vue) | Shared controls reviewed in source; native window behavior is outside the browser fixture review. |
| [desktop/welcome.vue](../../apps/web/app/pages/desktop/welcome.vue) | Shared controls reviewed in source; native window behavior is outside the browser fixture review. |
| [imprint.vue](../../apps/web/app/pages/imprint.vue) | Shared controls where used; public-page hierarchy retained. Token-dependent outcomes need real tokens. |
| [index.vue](../../apps/web/app/pages/index.vue) | Shared controls where used; public-page hierarchy retained. Token-dependent outcomes need real tokens. |
| [invite/accept.vue](../../apps/web/app/pages/invite/accept.vue) | Shared controls where used; public-page hierarchy retained. Token-dependent outcomes need real tokens. |
| [preferences.vue](../../apps/web/app/pages/preferences.vue) | Shared controls where used; public-page hierarchy retained. Token-dependent outcomes need real tokens. |
| [setup/admin.vue](../../apps/web/app/pages/setup/admin.vue) | Shared control sizing and alignment; existing wizard hierarchy retained. |
| [setup/email.vue](../../apps/web/app/pages/setup/email.vue) | Shared control sizing and alignment; existing wizard hierarchy retained. |
| [setup/features.vue](../../apps/web/app/pages/setup/features.vue) | Shared control sizing and alignment; existing wizard hierarchy retained. |
| [setup/index.vue](../../apps/web/app/pages/setup/index.vue) | Shared control sizing and alignment; existing wizard hierarchy retained. |
| [setup/mode.vue](../../apps/web/app/pages/setup/mode.vue) | Shared control sizing and alignment; existing wizard hierarchy retained. |
| [setup/review.vue](../../apps/web/app/pages/setup/review.vue) | Shared control sizing and alignment; existing wizard hierarchy retained. |
| [setup/team.vue](../../apps/web/app/pages/setup/team.vue) | Shared control sizing and alignment; existing wizard hierarchy retained. |
| [share.vue](../../apps/web/app/pages/share.vue) | Shared controls where used; public-page hierarchy retained. Token-dependent outcomes need real tokens. |
| [terms.vue](../../apps/web/app/pages/terms.vue) | Shared controls where used; public-page hierarchy retained. Token-dependent outcomes need real tokens. |
| [unsubscribe.vue](../../apps/web/app/pages/unsubscribe.vue) | Shared controls where used; public-page hierarchy retained. Token-dependent outcomes need real tokens. |
| [welcome.vue](../../apps/web/app/pages/welcome.vue) | Shared controls where used; public-page hierarchy retained. Token-dependent outcomes need real tokens. |
