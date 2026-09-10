English | [简体中文](video-projects.md)

# Media projects and autosave

The video plugin's `VideoProjects` owns project state at `stateRoot/projects/<id>.json`. The browser lists and creates projects through `/api/video/projects`, and reads and saves them through `/api/video/projects/<id>`. The project query parameter in the page URL identifies the project. Storage does not depend on localStorage or IndexedDB: clients accessing the same service and project ID read the same content.

The creation page supports My Projects, creation, opening, renaming and returning to the list. Cards, positions, prompts, first/last frames, reference asset IDs, generation parameters and locally generated audio are saved with the project. Audio Blobs are serialized into the project document and restored as playback URLs. Uploaded media retain server asset references; temporary playback URLs are not durable resources.

Edits trigger serial autosaves. Changes made during a save become the next latest snapshot. Normal save status is hidden; network failures and concurrent conflicts display errors. Leaving with unsaved changes triggers the browser's protection prompt. A failed read does not overwrite an existing project. Failed saves do not automatically retry an overwrite: retain the edits and resolve the error. Offline edits are not guaranteed saved.

The server writes a temporary file and atomically renames it, checks revisions and serializes writes within one process. When two clients submit the same revision, the later write receives 409 instead of silently overwriting. There is no expiry, automatic cleanup or archival policy, and this change does not delete projects. Project save requests are limited to 64 MiB.

Inference, model installation and project storage are separate capabilities; saving never starts GPU work. The installed plugin uses Manager access control. The local preview allows writes only to project routes with Origin checks; generation and installation remain read-only. Preview storage is separate from the installation and requires migration verification before claiming the data is available in the installed version.

Recorded validation covers creation replay, reading after service recreation, concurrent revision conflicts, project isolation, read-only rejection and path validation; browser creation, editing, server readback, refresh recovery and returning to the list were also checked during implementation. Project tiles show placeholder covers and edit times; canvas thumbnails are not generated.
