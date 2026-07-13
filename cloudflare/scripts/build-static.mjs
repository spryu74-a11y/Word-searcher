import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_STATIC_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_FREE_PLAN_FILES = 20_000;

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CLOUDFLARE_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_SOURCE_ROOT = resolve(CLOUDFLARE_ROOT, "..");
const DEFAULT_OUTPUT_ROOT = resolve(CLOUDFLARE_ROOT, "dist");

const ROOT_FILES = ["index.html", "app.js", "search-worker.js", "styles.css"];
const DATA_FILES = [
  "data/default-dictionary.js",
  "data/default-dictionary.txt",
  "data/default-dictionary-meta.json",
  "data/search-index-manifest.json"
];

export async function buildStaticAssets(options = {}) {
  const sourceRoot = resolve(options.sourceRoot || DEFAULT_SOURCE_ROOT);
  const outputRoot = resolve(options.outputRoot || DEFAULT_OUTPUT_ROOT);

  assertSeparateRoots(sourceRoot, outputRoot);
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  for (const file of ROOT_FILES) {
    await copyAllowedFile(sourceRoot, outputRoot, file);
  }
  for (const file of DATA_FILES) {
    await copyAllowedFile(sourceRoot, outputRoot, file);
  }
  await copyAllowedTree(sourceRoot, outputRoot, "assets");

  const manifestPath = resolve(sourceRoot, "data/search-index-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const shardFiles = referencedShardFiles(manifest);
  for (const file of shardFiles) {
    await copyAllowedFile(sourceRoot, outputRoot, `data/search-index-shards/${file}`);
  }

  const report = await validateOutput(outputRoot);
  if (report.files.some((file) => file.path === "data/search-index.json")) {
    throw new Error("Forbidden oversized fallback data/search-index.json entered the output.");
  }
  if (report.files.length > MAX_FREE_PLAN_FILES) {
    throw new Error(`Static asset count ${report.files.length} exceeds the Workers Free limit ${MAX_FREE_PLAN_FILES}.`);
  }
  return report;
}

export function referencedShardFiles(manifest) {
  if (!manifest || typeof manifest !== "object" || !manifest.shards || typeof manifest.shards !== "object") {
    throw new Error("Search index manifest does not contain a shards object.");
  }
  const files = new Set();
  for (const info of Object.values(manifest.shards)) {
    const file = info && typeof info === "object" ? info.file : "";
    if (typeof file !== "string" || !/^[a-f0-9]+\.json$/.test(file)) {
      throw new Error(`Unsafe or invalid shard filename in manifest: ${String(file)}`);
    }
    files.add(file);
  }
  if (files.size === 0) {
    throw new Error("Search index manifest references no shards.");
  }
  return Array.from(files).sort();
}

export async function validateOutput(outputRoot) {
  const root = resolve(outputRoot);
  const files = [];
  await walkFiles(root, async (absolutePath, fileInfo) => {
    const path = relative(root, absolutePath).split(sep).join("/");
    if (fileInfo.size > MAX_STATIC_ASSET_BYTES) {
      throw new Error(`${path} is ${(fileInfo.size / 1024 / 1024).toFixed(2)} MiB; Workers Static Assets allows 25 MiB per file.`);
    }
    files.push({ path, bytes: fileInfo.size });
  });
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    outputRoot: root,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0)
  };
}

async function copyAllowedTree(sourceRoot, outputRoot, relativeDirectory) {
  const sourceDirectory = safeResolve(sourceRoot, relativeDirectory);
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const child = `${relativeDirectory}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in static assets: ${child}`);
    }
    if (entry.isDirectory()) {
      await copyAllowedTree(sourceRoot, outputRoot, child);
    } else if (entry.isFile()) {
      await copyAllowedFile(sourceRoot, outputRoot, child);
    } else {
      throw new Error(`Unsupported filesystem entry in static assets: ${child}`);
    }
  }
}

async function copyAllowedFile(sourceRoot, outputRoot, relativePath) {
  const source = safeResolve(sourceRoot, relativePath);
  const destination = safeResolve(outputRoot, relativePath);
  const fileInfo = await stat(source);
  if (!fileInfo.isFile()) {
    throw new Error(`Required static asset is not a regular file: ${relativePath}`);
  }
  if (fileInfo.size > MAX_STATIC_ASSET_BYTES) {
    throw new Error(`${relativePath} exceeds the Workers Static Assets 25 MiB per-file limit.`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function copyStandaloneFile(source, destination) {
  const fileInfo = await stat(source);
  if (!fileInfo.isFile() || fileInfo.size > MAX_STATIC_ASSET_BYTES) {
    throw new Error(`Invalid static configuration file: ${source}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function walkFiles(directory, visitor) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in build output: ${path}`);
    }
    if (entry.isDirectory()) {
      await walkFiles(path, visitor);
    } else if (entry.isFile()) {
      await visitor(path, await stat(path));
    } else {
      throw new Error(`Unsupported filesystem entry in build output: ${path}`);
    }
  }
}

function safeResolve(root, relativePath) {
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, relativePath);
  if (candidate !== absoluteRoot && !candidate.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`Path escapes its allowed root: ${relativePath}`);
  }
  return candidate;
}

function assertSeparateRoots(sourceRoot, outputRoot) {
  if (sourceRoot === outputRoot || sourceRoot.startsWith(`${outputRoot}${sep}`)) {
    throw new Error("Source root must not be inside the disposable output directory.");
  }
}

async function main() {
  const report = await buildStaticAssets();
  const mebibytes = (report.totalBytes / 1024 / 1024).toFixed(2);
  process.stdout.write(`Built ${report.files.length} static assets (${mebibytes} MiB) in ${report.outputRoot}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
