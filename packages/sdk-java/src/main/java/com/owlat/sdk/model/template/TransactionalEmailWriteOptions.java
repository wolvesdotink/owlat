package com.owlat.sdk.model.template;

/** Options of a write to a transactional email. */
public class TransactionalEmailWriteOptions {

    private final Integer ifRevision;
    private final boolean whilePublished;

    private TransactionalEmailWriteOptions(Integer ifRevision, boolean whilePublished) {
        this.ifRevision = ifRevision;
        this.whilePublished = whilePublished;
    }

    /**
     * Refuse the write with a {@code ConflictException} (reason
     * {@code revision_mismatch}) when the email is no longer at {@code revision},
     * the revision a read returned.
     */
    public static TransactionalEmailWriteOptions ifRevision(int revision) {
        return new TransactionalEmailWriteOptions(revision, false);
    }

    /**
     * Change a published email in place. The change goes live at once, after
     * the content scan; without it a published email is refused with an
     * {@code InvalidStateException} (reason {@code email_published}).
     */
    public TransactionalEmailWriteOptions whilePublished() {
        return new TransactionalEmailWriteOptions(ifRevision, true);
    }

    /** No revision check, and a published email is refused. */
    public static TransactionalEmailWriteOptions none() {
        return new TransactionalEmailWriteOptions(null, false);
    }

    public Integer getIfRevision() {
        return ifRevision;
    }

    public boolean isWhilePublished() {
        return whilePublished;
    }
}
