// Lists every public repository with the topic sslcode-panel whose newest version passes Claude's
// check, in panels.json, and every version that failed, in panels-removed.json. Runs hourly.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, basename } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  MAX_PAGE_BYTES,
  MAX_TOOLS_SOURCE_BYTES,
  VERDICT_SCHEMA,
  addRemoved,
  fingerprint,
  isSourceFile,
  listedEntry,
  manifestProblem,
  reviewPrompt,
  triage,
  upsertListed,
} from "./lib.mjs";

const TOPIC = "sslcode-panel";
// Caps what one hour can spend if the topic is flooded; the rest wait for the next run.
const MAX_CHECKS_PER_RUN = 25;
const MODEL = "claude-opus-5-5";

const root = new URL("..", import.meta.url).pathname;
const readJson = (name) => JSON.parse(readFileSync(join(root, name), "utf8"));
const writeJson = (name, value) =>
  writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`);

/** A version that could not be checked this hour (a network error, say); it is tried again next hour. */
class NotNow extends Error {}
/** A version that fails for a reason the author can fix or should know about. */
class Refused extends Error {}

async function github(path, { raw = false } = {}) {
  const response = await fetch(path.startsWith("https://") ? path : `https://api.github.com${path}`, {
    headers: {
      Accept: raw ? "application/octet-stream" : "application/vnd.github+json",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      "User-Agent": "sslcode-panels-listing",
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new NotNow(`GitHub answered ${response.status} for ${path}`);
  return raw ? Buffer.from(await response.arrayBuffer()) : response.json();
}

async function rawFile(repo, commit, path) {
  const response = await fetch(
    `https://raw.githubusercontent.com/${repo}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`,
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new NotNow(`raw ${path} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function searchPanels() {
  const repos = [];
  for (let page = 1; page <= 10; page++) {
    const result = await github(
      `/search/repositories?q=${encodeURIComponent(`topic:${TOPIC} is:public`)}&per_page=100&page=${page}`,
    );
    for (const item of result.items) {
      if (item.archived || item.disabled) continue;
      repos.push(toRepo(item));
    }
    if (result.items.length < 100) break;
  }
  return repos;
}

const toRepo = (item) => ({
  fullName: item.full_name,
  owner: item.owner.login,
  defaultBranch: item.default_branch,
  stars: item.stargazers_count,
  createdAt: item.created_at,
  topics: item.topics ?? [],
});

/** The newest release when there is one, otherwise the newest commit on the default branch. */
async function newestVersion(repo) {
  const release = await github(`/repos/${repo.fullName}/releases/latest`);
  if (release) {
    const commit = await github(`/repos/${repo.fullName}/commits/${encodeURIComponent(release.tag_name)}`);
    if (!commit) throw new NotNow(`release ${release.tag_name} has no commit yet`);
    return { version: release.tag_name, commit: commit.sha, release };
  }
  const head = await github(`/repos/${repo.fullName}/commits/${encodeURIComponent(repo.defaultBranch)}`);
  if (!head) throw new NotNow("no commits");
  return { version: head.sha.slice(0, 7), commit: head.sha, release: null };
}

/** A release asset named like a file it ships must be that file at the release's commit. */
async function checkReleaseMatchesSource(release, sourceFiles) {
  for (const asset of release?.assets ?? []) {
    const source = sourceFiles.find(([path]) => basename(path) === asset.name);
    if (!source) continue;
    const bytes = await github(asset.url, { raw: true });
    if (!bytes || !bytes.equals(source[1])) {
      throw new Refused(`Its release file ${asset.name} differs from ${source[0]} in its source.`);
    }
  }
}

async function repoSourceFiles(repo, commit) {
  const tree = await github(`/repos/${repo}/git/trees/${commit}?recursive=1`);
  if (!tree || tree.truncated) throw new Refused("Its repository is too large to check.");
  const blobs = tree.tree.filter((node) => node.type === "blob" && isSourceFile(node.path));
  if (blobs.reduce((sum, node) => sum + node.size, 0) > MAX_TOOLS_SOURCE_BYTES) {
    throw new Refused("Its tools server's source is too large to check.");
  }
  return Promise.all(
    blobs.map(async (node) => [node.path, await rawFile(repo, commit, node.path)]),
  );
}

async function npmSourceFiles(spec) {
  const at = spec.lastIndexOf("@");
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/${version}`);
  if (response.status === 404) throw new Refused(`Its tools package ${spec} is not on npm.`);
  if (!response.ok) throw new NotNow(`npm answered ${response.status}`);
  const meta = await response.json();
  const tarball = await fetch(meta.dist.tarball);
  if (!tarball.ok) throw new NotNow(`npm tarball answered ${tarball.status}`);
  const dir = mkdtempSync(join(tmpdir(), "panel-npm-"));
  try {
    const file = join(dir, "package.tgz");
    writeFileSync(file, Buffer.from(await tarball.arrayBuffer()));
    execFileSync("tar", ["-xzf", file, "-C", dir, "--no-same-owner"]);
    const files = [];
    let total = 0;
    const walk = (folder) => {
      for (const name of readdirSync(folder)) {
        const path = join(folder, name);
        const stat = statSync(path);
        if (stat.isDirectory()) walk(path);
        else if (isSourceFile(relative(dir, path))) {
          total += stat.size;
          if (total > MAX_TOOLS_SOURCE_BYTES) {
            throw new Refused("Its tools server's source is too large to check.");
          }
          files.push([relative(join(dir, "package"), path), readFileSync(path)]);
        }
      }
    };
    walk(join(dir, "package"));
    return files;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

async function review(input) {
  if (!client) throw new NotNow("ANTHROPIC_API_KEY is not set");
  let response;
  try {
    response = await client.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: {
          effort: "high",
          format: { type: "json_schema", schema: VERDICT_SCHEMA },
        },
        messages: [{ role: "user", content: reviewPrompt(input) }],
      })
      .finalMessage();
  } catch (error) {
    if (error instanceof Anthropic.BadRequestError) {
      throw new Refused("It is too large for the check to read.");
    }
    throw new NotNow(`Claude: ${error.message}`);
  }
  if (response.stop_reason === "refusal") {
    throw new Refused("The check declined to review it.");
  }
  const text = response.content.find((block) => block.type === "text")?.text;
  if (response.stop_reason !== "end_turn" || !text) {
    throw new NotNow(`Claude stopped with ${response.stop_reason}`);
  }
  return JSON.parse(text);
}

async function checkVersion(repo, { version, commit, release }, listed) {
  const manifestBytes = await rawFile(repo.fullName, commit, "sslcode-panel.json");
  if (!manifestBytes) throw new Refused("It has no sslcode-panel.json at its root.");
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Refused("Its sslcode-panel.json is not valid JSON.");
  }
  const problem = manifestProblem(manifest);
  if (problem) throw new Refused(problem);

  const page = await rawFile(repo.fullName, commit, manifest.page);
  if (!page) throw new Refused(`Its page ${manifest.page} is missing.`);
  if (page.length > MAX_PAGE_BYTES) throw new Refused("Its page is larger than 5 MB.");
  if (!(await rawFile(repo.fullName, commit, manifest.icon))) {
    throw new Refused(`Its icon ${manifest.icon} is missing.`);
  }

  const toolsFiles = !manifest.tools
    ? []
    : manifest.tools.npx
      ? await npmSourceFiles(manifest.tools.npx)
      : await repoSourceFiles(repo.fullName, commit);
  const files = [
    ["sslcode-panel.json", manifestBytes],
    [`page:${manifest.page}`, page],
    ...toolsFiles.map(([path, content]) => [`tools:${path}`, content]),
  ];
  await checkReleaseMatchesSource(release, [[manifest.page, page], ...toolsFiles]);

  const print = fingerprint(files);
  const previous = listed.find((panel) => panel.repository === repo.fullName);
  const checkedAt = new Date().toISOString();
  if (previous?.fingerprint === print) {
    return listedEntry({ repo, version, commit, manifest, print, checkedAt: previous.checkedAt });
  }

  const verdict = await review({
    repo,
    manifest,
    page: page.toString("utf8"),
    toolsFiles: toolsFiles.map(([path, content]) => [path, content.toString("utf8")]),
    others: listed.filter((panel) => panel.repository !== repo.fullName),
  });
  if (!verdict.keep) throw new Refused(verdict.reason);
  console.log(`kept ${repo.fullName}@${version}: ${verdict.reason}`);
  return listedEntry({ repo, version, commit, manifest, print, checkedAt });
}

async function main() {
  let { panels: listed } = readJson("panels.json");
  let { removed } = readJson("panels-removed.json");
  const found = await searchPanels();
  let checks = 0;

  for (const repo of found) {
    try {
      const newest = await newestVersion(repo);
      const action = triage(repo.fullName, newest.commit, listed, removed);
      if (action !== "check") continue;
      if (checks >= MAX_CHECKS_PER_RUN) {
        console.log(`later ${repo.fullName}: this run's checks are used up`);
        continue;
      }
      checks++;
      try {
        listed = upsertListed(listed, await checkVersion(repo, newest, listed));
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        console.log(`removed ${repo.fullName}@${newest.version}: ${error.message}`);
        removed = addRemoved(removed, {
          repository: repo.fullName,
          version: newest.version,
          commit: newest.commit,
          reason: error.message,
          removedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.log(`skipped ${repo.fullName} this hour: ${error.message}`);
    }
  }

  // Search results can lag or miss; drop a listed panel only once its repository says it left.
  const foundNames = new Set(found.map((repo) => repo.fullName));
  for (const panel of listed.filter((entry) => !foundNames.has(entry.repository))) {
    try {
      const item = await github(`/repos/${panel.repository}`);
      if (!item || item.private || item.archived || !(item.topics ?? []).includes(TOPIC)) {
        console.log(`dropped ${panel.repository}: it is gone or no longer a panel`);
        listed = listed.filter((entry) => entry.repository !== panel.repository);
      }
    } catch (error) {
      console.log(`kept ${panel.repository} for now: ${error.message}`);
    }
  }

  writeJson("panels.json", { panels: listed });
  writeJson("panels-removed.json", { removed });
  console.log(`${listed.length} listed, ${removed.length} removed, ${checks} checked this run`);
}

await main();
