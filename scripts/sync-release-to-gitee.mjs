import { openAsBlob } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const owner = requiredEnv("GITEE_OWNER");
const repo = requiredEnv("GITEE_REPO");
const token = requiredEnv("GITEE_TOKEN");
const tagName = requiredEnv("RELEASE_TAG");
const artifactDir = path.resolve(process.env.ARTIFACT_DIR || "gitee-artifacts");
const prerelease = String(process.env.RELEASE_PRERELEASE || "false").toLowerCase() === "true";
const githubRepository = String(process.env.GITHUB_REPOSITORY || "chuxiajiurenzhan/video-agent-releases").trim();

if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tagName)) {
  throw new Error(`Invalid release tag: ${tagName}`);
}

const metadata = await readJson(path.join(artifactDir, "mirror-metadata.json"));
if (metadata.tagName !== tagName) {
  throw new Error(`Mirror metadata tag ${metadata.tagName} does not match ${tagName}.`);
}
const manifest = await readJson(path.join(artifactDir, metadata.manifestName));
if (manifest.installerSha256 !== metadata.installerSha256 || !Array.isArray(manifest.parts) || manifest.parts.length === 0) {
  throw new Error("Mirror metadata and manifest do not match.");
}

const artifactNames = [
  ...manifest.parts.map((item) => item.name),
  metadata.manifestName,
  metadata.downloaderName,
];
const availableNames = new Set(await readdir(artifactDir));
const artifacts = [];
for (const name of artifactNames) {
  if (!availableNames.has(name) || path.basename(name) !== name) {
    throw new Error(`Missing or invalid mirror asset: ${name}`);
  }
  const filePath = path.join(artifactDir, name);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size === 0) {
    throw new Error(`Empty mirror asset: ${name}`);
  }
  if (fileStat.size >= 100_000_000) {
    throw new Error(`Mirror asset exceeds Gitee's 100 MB attachment limit: ${name}`);
  }
  artifacts.push({ name, filePath, size: fileStat.size });
}
const totalSize = artifacts.reduce((sum, item) => sum + item.size, 0);
if (totalSize >= 950_000_000) {
  throw new Error(`Mirror assets use ${formatBytes(totalSize)}, leaving too little room in Gitee's 1 GB attachment quota.`);
}

const apiRoot = `https://gitee.com/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
await removeOlderMirrorReleases(apiRoot);

let release = await giteeRequest(`${apiRoot}/releases/tags/${encodeURIComponent(tagName)}`, { allowNotFound: true });
if (!release) {
  const body = new URLSearchParams({
    tag_name: tagName,
    name: `影迹Studio ${tagName}（国内备用镜像）`,
    body: [
      `影迹Studio Windows x64 客户端 ${tagName} 国内备用镜像。`,
      "",
      `请只下载并运行：${metadata.downloaderName}`,
      "下载器会自动获取全部分片、校验 SHA-256、合并原始安装包并启动安装。",
      "",
      `GitHub 主发布页：https://github.com/${githubRepository}/releases/tag/${tagName}`,
      `原始安装包：${manifest.installerName}`,
      `原始安装包 SHA-256：${manifest.installerSha256}`,
      "",
      "说明：受 Gitee 单附件大小限制，原始安装包已拆分保存；请勿手动逐个下载分片。Gitee 镜像仅保留最新版本。",
    ].join("\n"),
    target_commitish: "master",
    prerelease: String(prerelease),
  });
  release = await giteeRequest(`${apiRoot}/releases`, { method: "POST", body });
  console.log(`Created Gitee release ${tagName}.`);
} else {
  console.log(`Using existing Gitee release ${tagName}.`);
}

const releaseId = validId(release?.id, "release");
const attachmentsUrl = `${apiRoot}/releases/${releaseId}/attach_files`;
const attachmentResponse = await giteeRequest(attachmentsUrl);
const attachments = Array.isArray(attachmentResponse) ? attachmentResponse : [];
const existingNames = new Set(attachments.map((item) => item.name || item.file_name).filter(Boolean));

for (const artifact of artifacts) {
  if (existingNames.has(artifact.name)) {
    console.log(`Attachment already exists, skipping: ${artifact.name}`);
    continue;
  }
  await uploadWithRetry(attachmentsUrl, artifact);
}

console.log(`Gitee mirror is current: https://gitee.com/${owner}/${repo}/releases/tag/${tagName}`);

async function removeOlderMirrorReleases(apiRoot) {
  const response = await giteeRequest(`${apiRoot}/releases?page=1&per_page=100`);
  const releases = Array.isArray(response) ? response : [];
  for (const oldRelease of releases) {
    if (oldRelease.tag_name === tagName) continue;
    const oldReleaseId = validId(oldRelease.id, "old release");
    const attachmentsUrl = `${apiRoot}/releases/${oldReleaseId}/attach_files`;
    const attachmentResponse = await giteeRequest(attachmentsUrl);
    const attachments = Array.isArray(attachmentResponse) ? attachmentResponse : [];
    for (const attachment of attachments) {
      const attachmentId = validId(attachment.id, "attachment");
      await giteeRequest(`${attachmentsUrl}/${attachmentId}`, { method: "DELETE", expectJson: false });
      console.log(`Deleted old attachment: ${attachment.name || attachment.file_name || attachmentId}`);
    }
    await giteeRequest(`${apiRoot}/releases/${oldReleaseId}`, { method: "DELETE", expectJson: false });
    console.log(`Deleted old Gitee mirror release: ${oldRelease.tag_name || oldReleaseId}`);
  }
}

async function uploadWithRetry(url, artifact) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const form = new FormData();
    form.set("file", await openAsBlob(artifact.filePath), artifact.name);
    try {
      const uploaded = await giteeRequest(url, { method: "POST", body: form });
      console.log(`Uploaded ${artifact.name} (${formatBytes(artifact.size)})${uploaded?.browser_download_url ? ` -> ${uploaded.browser_download_url}` : ""}`);
      return;
    } catch (error) {
      const retryable = error.status === 429 || error.status >= 500;
      if (!retryable || attempt === 3) throw error;
      const delayMs = attempt * 15_000;
      console.warn(`Upload attempt ${attempt} failed for ${artifact.name}; retrying in ${delayMs / 1000}s.`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function giteeRequest(address, { method = "GET", body, allowNotFound = false, expectJson = true } = {}) {
  const requestUrl = new URL(address);
  if (method === "GET" || method === "DELETE") {
    requestUrl.searchParams.set("access_token", token);
  } else if (body instanceof URLSearchParams || body instanceof FormData) {
    body.set("access_token", token);
  }
  const headers = { Accept: "application/json" };
  if (body instanceof URLSearchParams) {
    headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
  }

  const response = await fetch(requestUrl, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(60 * 60 * 1000),
  });
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    const details = (await response.text()).slice(0, 1200).trim();
    const error = new Error(`Gitee API request failed: HTTP ${response.status}${details ? `\n${details}` : ""}`);
    error.status = response.status;
    throw error;
  }
  if (!expectJson || response.status === 204) return null;
  return response.json();
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function validId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Gitee API returned an invalid ${label} id.`);
  return id;
}

function formatBytes(value) {
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}
