package com.owlat.sdk.model.template;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.owlat.sdk.model.transactional.SendRefusal;
import java.util.List;

/** What a render answers. Nothing was stored. */
public class RenderResult {

    private final String kind;
    private final String language;
    private final boolean composed;
    private final String subject;
    private final String html;
    private final String text;
    private final String darkHtml;
    private final List<ContentIssue> issues;
    private final List<String> missingVariables;
    private final SendRefusal sendRefusal;
    private final EmailHealth health;

    @JsonCreator
    public RenderResult(
            @JsonProperty("kind") String kind,
            @JsonProperty("language") String language,
            @JsonProperty("composed") boolean composed,
            @JsonProperty("subject") String subject,
            @JsonProperty("html") String html,
            @JsonProperty("text") String text,
            @JsonProperty("darkHtml") String darkHtml,
            @JsonProperty("issues") List<ContentIssue> issues,
            @JsonProperty("missingVariables") List<String> missingVariables,
            @JsonProperty("sendRefusal") SendRefusal sendRefusal,
            @JsonProperty("health") EmailHealth health) {
        this.kind = kind;
        this.language = language;
        this.composed = composed;
        this.subject = subject;
        this.html = html;
        this.text = text;
        this.darkHtml = darkHtml;
        this.issues = issues;
        this.missingVariables = missingVariables;
        this.sendRefusal = sendRefusal;
        this.health = health;
    }

    /** {@code transactional} or {@code template}. */
    public String getKind() {
        return kind;
    }

    /** The language of the answer, after the fallback. */
    public String getLanguage() {
        return language;
    }

    /** Whether data variables were given and the answer is the composed email. */
    public boolean isComposed() {
        return composed;
    }

    public String getSubject() {
        return subject;
    }

    public String getHtml() {
        return html;
    }

    /** {@code null} for a translation that is not composed: a translation stores no text body. */
    public String getText() {
        return text;
    }

    /** With dark mode asked for, the HTML as a client in dark mode shows it; otherwise {@code null}. */
    public String getDarkHtml() {
        return darkHtml;
    }

    /** What the content check of a write finds: warnings and notes. */
    public List<ContentIssue> getIssues() {
        return issues;
    }

    /** Data variables used without a fallback that the request leaves out. */
    public List<String> getMissingVariables() {
        return missingVariables;
    }

    /** When composed: the refusal a send with this data would meet, or {@code null}. */
    public SendRefusal getSendRefusal() {
        return sendRefusal;
    }

    public EmailHealth getHealth() {
        return health;
    }
}
