import { createReadStream, openAsBlob } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const owner = requiredEnv("GITEE_OWNER");
const repo = requiredEnv("GITEE_REPO");
const token = requiredEnv("GITEE_TOKEN");
const tagName = requiredEnv("RELEASE_TAG");
const artifactDir = path.resolve(process.env.ARTIFACT_DIR || "artifacts");
const prerelease = String(process.env.RELEASE_PRERELEASE || "false").toLowerCase() === "true";

if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tagName)) {
  throw new Error(`Invalid release tag: ${tagName}`);
}

const names = await readdir(artifactDir);
const installerNames = names.filter((name) => /^YingJiStudio-Setup-.+-x64\.exe$/.test(name));
if (installerNames.length !== 1) {
  throw new Error(`Expected exactly one YingJiStudio Windows x64 installer, found ${installerNames.length}.`);
}

const installerName = installerNames[0];
const artifactNames = [installerName, `${installerName}.blockmap`, "latest.yml"];
const artifacts = [];
for (const name of artifactNames) {
  const filePath = path.join(artifactDir, name);
  const metadata = await stat(filePath).catch(() => null);
  if (!metadata?.isFile() || metadata.size === 0) {
    throw new Error(`Missing GitHub release asset: ${name}`);
  }
  artifacts.push({ name, filePath, size: metadata.size });
}

const installerSha256 = await sha256File(artifacts[0].filePath);
const apiRoot = `https://gitee.com/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
let release = await giteeRequest(`${apiRoot}/releases/tags/${encodeURIComponent(tagName)}`, { allowNotFound: true });

if (!release) {
  const body = new URLSearchParams({
    tag_name: tagName,
    name: `影迹Studio ${tagName}`,
    body: [
      `GitHub 主仓库同步版本：${tagName}`,
      "",
      `主发布页：https://github.com/${process.env.GITHUB_REPOSITORY}/releases/tag/${tagName}`,
      `安装包：${installerName}`,
      `SHA-256：${installerSha256}`,
    ].join("\n"),
    target_commitish: "master",
    prerelease: String(prerelease),
  });
  release = await giteeRequest(`${apiRoot}/releases`, { method: "POST", body });
  console.log(`Created Gitee release ${tagName}.`);
} else {
  console.log(`Using existing Gitee release ${tagName}.`);
}

const releaseId = Number(release?.id);
if (!Number.isInteger(releaseId) || releaseId <= 0) {
  throw new Error("Gitee API did not return a valid release id.");
}

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

async function giteeRequest(url, { method = "GET", body, allowNotFound = false } = {}) {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (body instanceof URLSearchParams) {
    headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
  }

  const response = await fetch(url, {
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
  if (response.status === 204) return null;
  return response.json();
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function formatBytes(value) {
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}
