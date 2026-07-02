package info.openrocket.core.document;

import info.openrocket.core.preferences.DocumentPreferences;

/**
 * SHIM: minimal document container. Rocket.java stores/returns a reference
 * and components store user materials into the document preferences. The
 * real document model arrives with .ork I/O work (P1.8) and replaces this.
 */
public class OpenRocketDocument {

    private final DocumentPreferences docPrefs = new DocumentPreferences();

    public DocumentPreferences getDocumentPreferences() {
        return docPrefs;
    }
}
