import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const [command, ...rawArgs] = process.argv.slice(2);
const args = parseArgs(rawArgs);

if (command === "create") {
  await createDelta({
    basePath: requiredArg(args, "base"),
    baseBlockmapPath: requiredArg(args, "base-blockmap"),
    targetPath: requiredArg(args, "target"),
    targetBlockmapPath: requiredArg(args, "target-blockmap"),
    patchPath: requiredArg(args, "patch"),
    manifestPath: requiredArg(args, "manifest"),
  });
} else if (command === "apply") {
  await applyDelta({
    basePath: requiredArg(args, "base"),
    patchPath: requiredArg(args, "patch"),
    manifestPath: requiredArg(args, "manifest"),
    outputPath: requiredArg(args, "output"),
  });
} else {
  throw new Error("用法：release-delta.mjs <create|apply> --base ...");
}

async function createDelta({
  basePath,
  baseBlockmapPath,
  targetPath,
  targetBlockmapPath,
  patchPath,
  manifestPath,
}) {
  const [baseMap, targetMap, baseMetadata, targetMetadata] = await Promise.all([
    readSingleFileBlockmap(baseBlockmapPath),
    readSingleFileBlockmap(targetBlockmapPath),
    stat(basePath),
    stat(targetPath),
  ]);
  assertBlockmapSize(baseMap, baseMetadata.size, "基础安装包");
  assertBlockmapSize(targetMap, targetMetadata.size, "目标安装包");

  const reusableChunks = new Map();
  let baseOffset = baseMap.offset;
  for (let index = 0; index < baseMap.checksums.length; index += 1) {
    const size = baseMap.sizes[index];
    const key = chunkKey(baseMap.checksums[index], size);
    if (!reusableChunks.has(key)) reusableChunks.set(key, baseOffset);
    baseOffset += size;
  }

  const targetHandle = await open(targetPath, "r");
  const patchHandle = await open(patchPath, "wx");
  const operations = [];
  let targetOffset = targetMap.offset;
  let patchOffset = 0;

  try {
    for (let index = 0; index < targetMap.checksums.length; index += 1) {
      const checksum = targetMap.checksums[index];
      const size = targetMap.sizes[index];
      const reusableOffset = reusableChunks.get(chunkKey(checksum, size));
      if (reusableOffset !== undefined) {
        operations.push([0, reusableOffset, size]);
      } else {
        const buffer = Buffer.allocUnsafe(size);
        await readExactly(targetHandle, buffer, size, targetOffset, "目标安装包");
        await writeExactly(patchHandle, buffer, size, patchOffset, "增量文件");
        operations.push([1, patchOffset, size]);
        patchOffset += size;
      }
      targetOffset += size;
    }
    await patchHandle.sync();
  } catch (error) {
    await Promise.allSettled([targetHandle.close(), patchHandle.close()]);
    await unlink(patchPath).catch(() => {});
    throw error;
  }
  await Promise.all([targetHandle.close(), patchHandle.close()]);

  const [baseSha256, targetSha256, patchSha256] = await Promise.all([
    sha256File(basePath),
    sha256File(targetPath),
    sha256File(patchPath),
  ]);
  const manifest = {
    schemaVersion: 1,
    base: {
      name: path.basename(basePath),
      size: baseMetadata.size,
      sha256: baseSha256,
    },
    target: {
      name: path.basename(targetPath),
      size: targetMetadata.size,
      sha256: targetSha256,
    },
    patch: {
      name: path.basename(patchPath),
      size: patchOffset,
      sha256: patchSha256,
    },
    operations,
  };
  await writeFile(manifestPath, gzipSync(Buffer.from(`${JSON.stringify(manifest)}\n`), { level: 9 }), {
    flag: "wx",
  });

  console.log(JSON.stringify({
    mode: "create",
    baseSize: baseMetadata.size,
    targetSize: targetMetadata.size,
    patchSize: patchOffset,
    reusedBytes: targetMetadata.size - patchOffset,
    reusedPercent: Number((((targetMetadata.size - patchOffset) / targetMetadata.size) * 100).toFixed(2)),
    targetSha256,
    patchSha256,
    operationCount: operations.length,
  }, null, 2));
}

async function applyDelta({ basePath, patchPath, manifestPath, outputPath }) {
  const manifest = JSON.parse(gunzipSync(await readFile(manifestPath)).toString("utf8"));
  validateManifest(manifest);
  assertEqual(path.basename(basePath), manifest.base.name, "基础安装包文件名");
  assertEqual(path.basename(patchPath), manifest.patch.name, "增量文件名");
  assertEqual(path.basename(outputPath), manifest.target.name, "目标安装包文件名");

  const [baseMetadata, patchMetadata, baseSha256, patchSha256] = await Promise.all([
    stat(basePath),
    stat(patchPath),
    sha256File(basePath),
    sha256File(patchPath),
  ]);
  assertEqual(baseMetadata.size, manifest.base.size, "基础安装包大小");
  assertEqual(baseSha256, manifest.base.sha256, "基础安装包 SHA-256");
  assertEqual(patchMetadata.size, manifest.patch.size, "增量文件大小");
  assertEqual(patchSha256, manifest.patch.sha256, "增量文件 SHA-256");

  const baseHandle = await open(basePath, "r");
  const patchHandle = await open(patchPath, "r");
  const outputHandle = await open(outputPath, "wx");
  const outputHash = createHash("sha256");
  const maxChunkSize = Math.max(...manifest.operations.map((operation) => operation[2]));
  const buffer = Buffer.allocUnsafe(maxChunkSize);
  let outputOffset = 0;

  try {
    for (const [source, sourceOffset, size] of manifest.operations) {
      const sourceHandle = source === 0 ? baseHandle : patchHandle;
      await readExactly(sourceHandle, buffer, size, sourceOffset, source === 0 ? "基础安装包" : "增量文件");
      await writeExactly(outputHandle, buffer, size, outputOffset, "重建安装包");
      outputHash.update(buffer.subarray(0, size));
      outputOffset += size;
    }
    await outputHandle.sync();
  } catch (error) {
    await Promise.allSettled([baseHandle.close(), patchHandle.close(), outputHandle.close()]);
    await unlink(outputPath).catch(() => {});
    throw error;
  }
  await Promise.all([baseHandle.close(), patchHandle.close(), outputHandle.close()]);

  const outputSha256 = outputHash.digest("hex");
  if (outputOffset !== manifest.target.size || outputSha256 !== manifest.target.sha256) {
    await unlink(outputPath).catch(() => {});
    throw new Error(`重建结果校验失败：size=${outputOffset}, sha256=${outputSha256}`);
  }

  console.log(JSON.stringify({
    mode: "apply",
    outputPath,
    outputSize: outputOffset,
    outputSha256,
  }, null, 2));
}

async function readSingleFileBlockmap(blockmapPath) {
  const blockmap = JSON.parse(gunzipSync(await readFile(blockmapPath)).toString("utf8"));
  if (!Array.isArray(blockmap.files) || blockmap.files.length !== 1) {
    throw new Error(`仅支持单文件 blockmap：${blockmapPath}`);
  }
  const file = blockmap.files[0];
  if (!Array.isArray(file.checksums) || !Array.isArray(file.sizes) || file.checksums.length !== file.sizes.length) {
    throw new Error(`blockmap 分块信息无效：${blockmapPath}`);
  }
  const sizes = file.sizes.map((value) => Number(value));
  if (sizes.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`blockmap 分块大小无效：${blockmapPath}`);
  }
  const offset = Number(file.offset || 0);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`blockmap 偏移无效：${blockmapPath}`);
  return { checksums: file.checksums, sizes, offset };
}

function assertBlockmapSize(blockmap, expectedSize, label) {
  const mappedSize = blockmap.offset + blockmap.sizes.reduce((total, value) => total + value, 0);
  assertEqual(mappedSize, expectedSize, `${label} blockmap 覆盖大小`);
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1) throw new Error("不支持的增量清单版本");
  for (const key of ["base", "target", "patch"]) {
    const item = manifest[key];
    if (
      !item
      || typeof item.name !== "string"
      || item.name.length === 0
      || path.basename(item.name) !== item.name
      || !Number.isSafeInteger(item.size)
      || item.size < 0
      || !/^[a-f0-9]{64}$/.test(item.sha256)
    ) {
      throw new Error(`增量清单 ${key} 信息无效`);
    }
  }
  if (!Array.isArray(manifest.operations) || manifest.operations.length === 0) {
    throw new Error("增量清单缺少重建操作");
  }
  let targetSize = 0;
  for (const operation of manifest.operations) {
    if (!Array.isArray(operation) || operation.length !== 3) throw new Error("增量清单操作格式无效");
    const [source, offset, size] = operation;
    if ((source !== 0 && source !== 1) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size <= 0) {
      throw new Error("增量清单操作数值无效");
    }
    const sourceSize = source === 0 ? manifest.base.size : manifest.patch.size;
    if (offset + size > sourceSize) throw new Error("增量清单操作越界");
    targetSize += size;
  }
  assertEqual(targetSize, manifest.target.size, "增量清单目标大小");
}

async function readExactly(handle, buffer, size, position, label) {
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, position + offset);
    if (bytesRead === 0) throw new Error(`${label}读取提前结束`);
    offset += bytesRead;
  }
}

async function writeExactly(handle, buffer, size, position, label) {
  let offset = 0;
  while (offset < size) {
    const { bytesWritten } = await handle.write(buffer, offset, size - offset, position + offset);
    if (bytesWritten === 0) throw new Error(`${label}写入失败`);
    offset += bytesWritten;
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function chunkKey(checksum, size) {
  return `${checksum}:${size}`;
}

function parseArgs(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`无效参数：${key || "空"}`);
    parsed.set(key.slice(2), value);
  }
  return parsed;
}

function requiredArg(values, name) {
  const value = String(values.get(name) || "").trim();
  if (!value) throw new Error(`缺少参数：--${name}`);
  return value;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}不匹配：expected=${expected}, actual=${actual}`);
}
