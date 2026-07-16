# YingJi Studio Desktop Releases

This public repository is the primary release source for YingJi Studio Windows desktop clients and automatic updates.

Release assets may include:

- `latest.yml`
- `YingJiStudio-Setup-<version>-x64.exe`
- `YingJiStudio-Setup-<version>-x64.exe.blockmap`

The application source code, server code, environment files, credentials, API keys, signing certificates, debug logs, and source maps are not stored in this repository.

## Publishing

Releases are uploaded as drafts from the private build workspace. A draft becomes visible to desktop clients only after it is reviewed and published on GitHub.

When a GitHub Release is published, the `Sync GitHub release to Gitee` workflow mirrors the same assets to `chuxiajiurenzhan/video-agent-releases` on Gitee. GitHub remains the primary source and automatic-update endpoint; Gitee is a download fallback for users in mainland China.

The repository Actions secret `GITEE_TOKEN` must contain a Gitee personal access token with permission to manage releases in the mirror repository.
