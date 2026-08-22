# YingJi Studio Desktop Releases

This public repository is the primary release source for YingJi Studio Windows desktop clients and automatic updates.

Release assets may include:

- `latest.yml`
- `YingJiStudio-Setup-<version>-x64.exe`
- `YingJiStudio-Setup-<version>-x64.exe.blockmap`

The application source code, server code, environment files, credentials, API keys, signing certificates, debug logs, and source maps are not stored in this repository.

## Publishing

Releases are uploaded as drafts from the private build workspace. A draft becomes visible to desktop clients only after it is reviewed and published on GitHub.

For constrained upload links, the `Reconstruct draft installer` workflow can rebuild an installer inside GitHub from the previous published installer plus a verified content-defined delta. The workflow rechecks the target draft before every mutation, validates asset names, base, patch, output size, and SHA-256, uploads the exact reconstructed installer, and removes the temporary delta assets. It never publishes the release.

The automatic Gitee mirror is temporarily paused because the current upload path cannot yet verify a complete remote attachment set. GitHub remains the only published download source, full release archive, and automatic-update endpoint until the mirror is repaired and validated end to end. The `Sync GitHub release to Gitee` workflow is manual-only during this period.

Because Gitee limits individual release attachments to 100 MB and total release attachments in a repository to 1 GB, the workflow splits the latest Windows installer into verified parts and builds a small one-click Windows downloader. The Gitee mirror intentionally keeps only the newest release; GitHub retains the complete release history.

The repository Actions secret `GITEE_TOKEN` must contain a Gitee personal access token with permission to manage releases in the mirror repository.
