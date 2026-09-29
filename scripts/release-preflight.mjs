import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";

const TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseReleaseTag(tag) {
  if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) {
    throw new Error("tag must match vMAJOR.MINOR.PATCH with no leading-zero numeric identifiers");
  }
  const [, major, minor, patch] = TAG_PATTERN.exec(tag);
  return { tag, version: `${major}.${minor}.${patch}` };
}

export function validateRepository(repository) {
  if (typeof repository !== "string" || !REPOSITORY_PATTERN.test(repository)) {
    throw new Error("repository must be an owner/name identifier");
  }
  return repository;
}

export function validatePackageVersion(packageVersion, expectedVersion) {
  if (packageVersion !== expectedVersion) {
    throw new Error(`package.json version ${JSON.stringify(packageVersion)} does not match release ${expectedVersion}`);
  }
}

export function requireReachableFromMain(compareStatus) {
  if (compareStatus !== "ahead" && compareStatus !== "identical") {
    throw new Error(`tag commit is not reachable from main (compare status: ${compareStatus})`);
  }
}

function usage() {
  return "Usage: node scripts/release-preflight.mjs --tag vMAJOR.MINOR.PATCH --repository owner/name [--output path]";
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--tag" || argument === "--repository" || argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      values[argument.slice(2)] = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  if (!values.tag || !values.repository) throw new Error(usage());
  return values;
}

function apiClient() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required for release preflight");
  const base = new URL(process.env.GITHUB_API_URL || "https://api.github.com/");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return async (path) => {
    const response = await fetch(new URL(path.replace(/^\//, ""), base), {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub API request failed (${response.status}) for ${path}`);
    }
    return response.json();
  };
}

async function resolveTagCommit(get, repository, tag) {
  let reference = await get(`repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`);
  for (let depth = 0; depth < 4 && reference.object?.type === "tag"; depth += 1) {
    reference = await get(`repos/${repository}/git/tags/${reference.object.sha}`);
  }
  if (reference.object?.type !== "commit" || !/^[0-9a-f]{40}$/i.test(reference.object.sha)) {
    throw new Error("release tag does not resolve to a commit");
  }
  return reference.object.sha;
}

async function readPackageAtTag(get, repository, tag) {
  const document = await get(`repos/${repository}/contents/package.json?ref=${encodeURIComponent(tag)}`);
  if (Array.isArray(document) || document.encoding !== "base64" || typeof document.content !== "string") {
    throw new Error("package.json could not be read at the release tag");
  }
  try {
    return JSON.parse(Buffer.from(document.content.replaceAll("\n", ""), "base64"));
  } catch {
    throw new Error("package.json at the release tag is not valid JSON");
  }
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const { tag, version } = parseReleaseTag(arguments_.tag);
  const repository = validateRepository(arguments_.repository);
  const get = apiClient();

  const release = await get(`repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);
  if (release.tag_name !== tag || release.draft || release.prerelease || !release.published_at) {
    throw new Error("release must be published, non-draft, and non-prerelease");
  }

  const tagCommit = await resolveTagCommit(get, repository, tag);
  const main = await get(`repos/${repository}/branches/main`);
  const mainCommit = main.commit?.sha;
  if (!/^[0-9a-f]{40}$/i.test(mainCommit || "")) throw new Error("main branch did not resolve to a commit");
  const comparison = await get(`repos/${repository}/compare/${tagCommit}...${mainCommit}`);
  requireReachableFromMain(comparison.status);

  const packageJson = await readPackageAtTag(get, repository, tagCommit);
  validatePackageVersion(packageJson.version, version);

  const result = {
    tag,
    version,
    commit: tagCommit,
    mainCommit,
  };
  const serialized = `${JSON.stringify(result)}\n`;
  if (arguments_.output) await writeFile(arguments_.output, serialized, "utf8");
  else process.stdout.write(serialized);
}

const invokedPath = process.argv[1] && pathToFileURL(process.argv[1]).href;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`Release preflight failed: ${error.message}`);
    process.exitCode = 1;
  });
}
