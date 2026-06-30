package com.owlat.sdk.model.transactional;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class TransactionalAttachmentTest {

    @Test
    void builderCreatesAttachmentWithContent() {
        TransactionalAttachment attachment = TransactionalAttachment.builder("invoice.pdf")
                .content("base64data")
                .contentType("application/pdf")
                .build();

        assertEquals("invoice.pdf", attachment.getFilename());
        assertEquals("base64data", attachment.getContent());
        assertNull(attachment.getUrl());
        assertEquals("application/pdf", attachment.getContentType());
    }

    @Test
    void builderCreatesAttachmentWithUrl() {
        TransactionalAttachment attachment = TransactionalAttachment.builder("report.pdf")
                .url("https://example.com/report.pdf")
                .build();

        assertEquals("report.pdf", attachment.getFilename());
        assertNull(attachment.getContent());
        assertEquals("https://example.com/report.pdf", attachment.getUrl());
        assertNull(attachment.getContentType());
    }

    @Test
    void builderThrowsWhenFilenameIsNull() {
        assertThrows(IllegalArgumentException.class, () ->
                TransactionalAttachment.builder(null)
                        .content("data")
                        .build()
        );
    }

    @Test
    void builderThrowsWhenFilenameIsEmpty() {
        assertThrows(IllegalArgumentException.class, () ->
                TransactionalAttachment.builder("")
                        .content("data")
                        .build()
        );
    }

    @Test
    void builderThrowsWhenNeitherContentNorUrl() {
        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class, () ->
                TransactionalAttachment.builder("file.txt").build()
        );
        assertEquals("Attachment must have either content or url", ex.getMessage());
    }

    @Test
    void builderThrowsWhenBothContentAndUrl() {
        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class, () ->
                TransactionalAttachment.builder("file.txt")
                        .content("data")
                        .url("https://example.com/file.txt")
                        .build()
        );
        assertEquals("Attachment must have either content or url, not both", ex.getMessage());
    }
}
