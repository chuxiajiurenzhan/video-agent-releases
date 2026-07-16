import { mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const tagName = requiredEnv("RELEASE_TAG");
const owner = String(process.env.GITEE_OWNER || "chuxiajiurenzhan").trim();
const repo = String(process.env.GITEE_REPO || "video-agent-releases").trim();
const sourceDir = path.resolve(process.env.SOURCE_ARTIFACT_DIR || "artifacts");
const outputDir = path.resolve(process.env.MIRROR_ARTIFACT_DIR || "gitee-artifacts");
const partSize = Number(process.env.GITEE_PART_SIZE_BYTES || 90_000_000);

if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tagName)) {
  throw new Error(`无效的发行标签：${tagName}`);
}
if (!Number.isInteger(partSize) || partSize <= 0 || partSize >= 100_000_000) {
  throw new Error("GITEE_PART_SIZE_BYTES 必须是小于 100,000,000 的正整数。");
}

const sourceNames = await readdir(sourceDir);
const releaseVersion = tagName.replace(/^v/, "");
const installerName = `YingJiStudio-Setup-${releaseVersion}-x64.exe`;
if (!sourceNames.includes(installerName)) {
  throw new Error(`缺少与发行标签 ${tagName} 对应的安装包：${installerName}`);
}
const installerPath = path.join(sourceDir, installerName);
const installerMetadata = await stat(installerPath);
const blockmapName = `${installerName}.blockmap`;
for (const name of [blockmapName, "latest.yml"]) {
  const metadata = await stat(path.join(sourceDir, name)).catch(() => null);
  if (!metadata?.isFile() || metadata.size === 0) throw new Error(`缺少 GitHub Release 产物：${name}`);
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const source = await open(installerPath, "r");
const fullHash = createHash("sha256");
const parts = [];
const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
let sourceOffset = 0;
let partIndex = 0;

try {
  while (sourceOffset < installerMetadata.size) {
    partIndex += 1;
    const partName = `${installerName}.part${String(partIndex).padStart(2, "0")}`;
    const partPath = path.join(outputDir, partName);
    const target = await open(partPath, "w");
    const partHash = createHash("sha256");
    const expectedPartSize = Math.min(partSize, installerMetadata.size - sourceOffset);
    let partOffset = 0;
    try {
      while (partOffset < expectedPartSize) {
        const readLength = Math.min(buffer.length, expectedPartSize - partOffset);
        const { bytesRead } = await source.read(buffer, 0, readLength, sourceOffset);
        if (!bytesRead) throw new Error(`读取安装包时提前结束：${installerPath}`);
        const chunk = buffer.subarray(0, bytesRead);
        await target.write(chunk, 0, bytesRead, partOffset);
        fullHash.update(chunk);
        partHash.update(chunk);
        sourceOffset += bytesRead;
        partOffset += bytesRead;
      }
    } finally {
      await target.close();
    }
    parts.push({
      name: partName,
      size: partOffset,
      sha256: partHash.digest("hex"),
    });
    console.log(`已生成分片：${partName} (${formatBytes(partOffset)})`);
  }
} finally {
  await source.close();
}

const installerSha256 = fullHash.digest("hex");
const manifestName = installerName.replace(/\.exe$/, ".gitee.json");
const baseUrl = `https://gitee.com/${owner}/${repo}/releases/download/${tagName}`;
const manifest = {
  version: releaseVersion,
  installerName,
  installerSize: installerMetadata.size,
  installerSha256,
  baseUrl,
  parts,
};

await writeFile(path.join(outputDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const metadataPath = path.join(outputDir, "mirror-metadata.json");
await writeFile(metadataPath, `${JSON.stringify({
  tagName,
  manifestName,
  downloaderName: installerName.replace(/\.exe$/, "-Gitee-Downloader.exe"),
  manifestUrl: `${baseUrl}/${encodeURIComponent(manifestName)}`,
  installerSha256,
  partCount: parts.length,
}, null, 2)}\n`, "utf8");

console.log(`Gitee 镜像准备完成：${outputDir}`);
console.log(`安装包 SHA-256：${installerSha256}`);
console.log(`分片数量：${parts.length}`);

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
}

function formatBytes(value) {
  return `${(value / 1_000_000).toFixed(1)} MB`;
}
