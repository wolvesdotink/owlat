package com.owlat.sdk.model.transactional;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/** What a dry run of a send answers. Nothing was sent, stored or counted. */
public class SendTransactionalDryRun {

    private final String status;
    private final boolean dryRun;
    private final boolean wouldQueue;
    private final SendRefusal refusal;
    private final String email;
    private final String templateId;
    private final String slug;
    private final String templateStatus;
    private final String contactId;
    private final String language;
    private final String subject;
    private final String html;
    private final String text;
    private final boolean unsubscribeFooter;
    private final List<String> missingVariables;

    @JsonCreator
    public SendTransactionalDryRun(
            @JsonProperty("status") String status,
            @JsonProperty("dryRun") boolean dryRun,
            @JsonProperty("wouldQueue") boolean wouldQueue,
            @JsonProperty("refusal") SendRefusal refusal,
            @JsonProperty("email") String email,
            @JsonProperty("templateId") String templateId,
            @JsonProperty("slug") String slug,
            @JsonProperty("templateStatus") String templateStatus,
            @JsonProperty("contactId") String contactId,
            @JsonProperty("language") String language,
            @JsonProperty("subject") String subject,
            @JsonProperty("html") String html,
            @JsonProperty("text") String text,
            @JsonProperty("unsubscribeFooter") boolean unsubscribeFooter,
            @JsonProperty("missingVariables") List<String> missingVariables) {
        this.status = status;
        this.dryRun = dryRun;
        this.wouldQueue = wouldQueue;
        this.refusal = refusal;
        this.email = email;
        this.templateId = templateId;
        this.slug = slug;
        this.templateStatus = templateStatus;
        this.contactId = contactId;
        this.language = language;
        this.subject = subject;
        this.html = html;
        this.text = text;
        this.unsubscribeFooter = unsubscribeFooter;
        this.missingVariables = missingVariables;
    }

    /** Always {@code dry_run}, never {@code queued}. */
    public String getStatus() {
        return status;
    }

    /** Always {@code true}. */
    public boolean isDryRun() {
        return dryRun;
    }

    /** Whether a send of this request would be queued now. */
    public boolean isWouldQueue() {
        return wouldQueue;
    }

    /** The first refusal a send would meet now, or {@code null}. */
    public SendRefusal getRefusal() {
        return refusal;
    }

    public String getEmail() {
        return email;
    }

    /** The transactional email, not a send. */
    public String getTemplateId() {
        return templateId;
    }

    public String getSlug() {
        return slug;
    }

    /** {@code draft}, {@code pending_review} or {@code published}. */
    public String getTemplateStatus() {
        return templateStatus;
    }

    /** The recipient's contact, or {@code null} when a send would create one. */
    public String getContactId() {
        return contactId;
    }

    public String getLanguage() {
        return language;
    }

    public String getSubject() {
        return subject;
    }

    /** The HTML a send would deliver, without the unsubscribe footer delivery appends. */
    public String getHtml() {
        return html;
    }

    public String getText() {
        return text;
    }

    /** Whether delivery appends the unsubscribe footer, which the dry run leaves out. */
    public boolean isUnsubscribeFooter() {
        return unsubscribeFooter;
    }

    /** Data variables the email uses without a fallback that the request leaves out. */
    public List<String> getMissingVariables() {
        return missingVariables;
    }
}
