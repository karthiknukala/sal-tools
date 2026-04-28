const vscode = require("vscode");
const childProcess = require("child_process");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { promisify } = require("util");

const execFile = promisify(childProcess.execFile);

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("helloWorld.hello", () => {
      vscode.window.showInformationMessage("Hello World");
    }),
    vscode.commands.registerCommand("sal.installFromGitHubRelease", () =>
      installFromGitHubRelease(context)
    )
  );
}

async function installFromGitHubRelease(context) {
  const config = vscode.workspace.getConfiguration("sal");
  const repository = String(
    config.get("install.repository", "karthiknukala/sal")
  ).trim();
  const releaseTag = String(config.get("install.releaseTag", "nightly")).trim();

  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    vscode.window.showErrorMessage(
      "Set sal.install.repository to a GitHub owner/repo value."
    );
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Installing SAL",
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "Reading GitHub release..." });
        const release = await getGitHubRelease(repository, releaseTag);
        const asset = await chooseReleaseAsset(release);

        if (!asset) {
          throw new Error(`No downloadable assets found for ${release.html_url}.`);
        }

        await vscode.workspace.fs.createDirectory(context.globalStorageUri);

        const installRoot = getInstallRoot(context, config);
        const releaseName = sanitizePathSegment(release.tag_name || "latest");
        const targetDir = path.join(installRoot, releaseName);
        const archivePath = path.join(os.tmpdir(), asset.name);

        await fs.promises.mkdir(installRoot, { recursive: true });
        await fs.promises.rm(targetDir, { recursive: true, force: true });
        await fs.promises.mkdir(targetDir, { recursive: true });

        let lastDownloadProgress = 0;
        await downloadFile(asset.browser_download_url, archivePath, (ratio) => {
          const nextProgress = Math.floor(ratio * 65);
          const increment = Math.max(0, nextProgress - lastDownloadProgress);
          lastDownloadProgress = nextProgress;
          progress.report({
            increment,
            message: `Downloading ${asset.name}...`,
          });
        });

        progress.report({ message: "Extracting release..." });
        await extractAsset(archivePath, targetDir);
        await fs.promises.rm(archivePath, { force: true });

        const binPath = await findToolchainBinPath(targetDir);
        await markSalExecutables(binPath);

        await config.update(
          "toolchain.binPath",
          binPath,
          vscode.ConfigurationTarget.Global
        );

        progress.report({ increment: 35, message: "Done" });
        vscode.window.showInformationMessage(
          `Installed SAL ${release.tag_name || release.name} and set sal.toolchain.binPath.`
        );
      }
    );
  } catch (error) {
    vscode.window.showErrorMessage(`SAL install failed: ${error.message}`);
  }
}

async function getGitHubRelease(repository, releaseTag) {
  const endpoint = releaseTag
    ? `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(
        releaseTag
      )}`
    : `https://api.github.com/repos/${repository}/releases/latest`;
  return requestJson(endpoint);
}

async function chooseReleaseAsset(release) {
  const assets = (release.assets || []).filter(
    (asset) => asset.browser_download_url && !isChecksum(asset.name)
  );

  if (assets.length === 0) {
    return undefined;
  }

  const scored = assets
    .map((asset) => ({ asset, score: scoreAsset(asset.name) }))
    .sort((left, right) => right.score - left.score);

  if (scored.length === 1 || scored[0].score > 0) {
    return scored[0].asset;
  }

  const picked = await vscode.window.showQuickPick(
    scored.map(({ asset }) => ({
      label: asset.name,
      description: formatBytes(asset.size),
      asset,
    })),
    { placeHolder: "Choose the SAL release asset to install" }
  );

  return picked && picked.asset;
}

function scoreAsset(name) {
  const lowerName = name.toLowerCase();
  let score = isArchive(lowerName) ? 10 : 0;

  for (const token of platformTokens()) {
    if (lowerName.includes(token)) {
      score += 40;
    }
  }

  for (const token of archTokens()) {
    if (lowerName.includes(token)) {
      score += 25;
    }
  }

  if (lowerName.includes("source")) {
    score -= 50;
  }

  return score;
}

function platformTokens() {
  if (process.platform === "darwin") {
    return ["darwin", "macos", "mac", "osx"];
  }
  if (process.platform === "win32") {
    return ["windows", "win32", "win"];
  }
  return [process.platform];
}

function archTokens() {
  if (process.arch === "x64") {
    return ["x64", "x86_64", "amd64", "x86", "intel", "universal"];
  }
  if (process.arch === "arm64") {
    return ["arm64", "aarch64", "apple-silicon", "silicon", "m1", "m2", "universal"];
  }
  return [process.arch];
}

function getInstallRoot(context, config) {
  const configuredDir = String(config.get("install.directory", "")).trim();
  if (configuredDir) {
    return configuredDir.replace(/^~(?=$|\/|\\)/, os.homedir());
  }
  return path.join(context.globalStorageUri.fsPath, "sal");
}

async function downloadFile(url, targetPath, reportProgress) {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const request = https.get(url, requestHeaders(), (response) => {
      if (isRedirect(response.statusCode)) {
        response.resume();
        const location = new URL(response.headers.location, url).toString();
        downloadFile(location, targetPath, reportProgress).then(resolve, reject);
        return;
      }

      if (!isSuccess(response.statusCode)) {
        reject(new Error(`Download returned HTTP ${response.statusCode}.`));
        response.resume();
        return;
      }

      const totalBytes = Number(response.headers["content-length"] || 0);
      let receivedBytes = 0;
      const file = fs.createWriteStream(targetPath);

      response.on("data", (chunk) => {
        receivedBytes += chunk.length;
        if (totalBytes > 0) {
          reportProgress(receivedBytes / totalBytes);
        }
      });

      response.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    });

    request.on("error", reject);
  });
}

async function extractAsset(assetPath, targetDir) {
  const lowerPath = assetPath.toLowerCase();

  if (lowerPath.endsWith(".zip")) {
    await runFirst([
      ["unzip", ["-q", "-o", assetPath, "-d", targetDir]],
      ["tar", ["-xf", assetPath, "-C", targetDir]],
    ]);
    return;
  }

  if (isArchive(lowerPath)) {
    await execFile("tar", ["-xf", assetPath, "-C", targetDir]);
    return;
  }

  const fileName = path.basename(assetPath);
  await fs.promises.copyFile(assetPath, path.join(targetDir, fileName));
}

async function runFirst(commands) {
  let lastError;

  for (const [command, args] of commands) {
    try {
      await execFile(command, args);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function findToolchainBinPath(rootDir) {
  const directBin = await findDirectory(rootDir, (dir, entries) => {
    return (
      path.basename(dir) === "bin" &&
      entries.some((entry) => isSalExecutableName(entry.name))
    );
  });

  if (directBin) {
    return directBin;
  }

  const toolFile = await findFile(rootDir, (entry) =>
    isSalExecutableName(entry.name)
  );

  return toolFile ? path.dirname(toolFile) : rootDir;
}

async function findDirectory(rootDir, predicate, depth = 0) {
  if (depth > 5) {
    return undefined;
  }

  const entries = await safeReadDir(rootDir);
  if (predicate(rootDir, entries)) {
    return rootDir;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await findDirectory(
        path.join(rootDir, entry.name),
        predicate,
        depth + 1
      );
      if (found) {
        return found;
      }
    }
  }

  return undefined;
}

async function findFile(rootDir, predicate, depth = 0) {
  if (depth > 5) {
    return undefined;
  }

  for (const entry of await safeReadDir(rootDir)) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isFile() && predicate(entry)) {
      return entryPath;
    }
    if (entry.isDirectory()) {
      const found = await findFile(entryPath, predicate, depth + 1);
      if (found) {
        return found;
      }
    }
  }

  return undefined;
}

async function safeReadDir(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function markSalExecutables(dir) {
  if (process.platform === "win32") {
    return;
  }

  for (const entry of await safeReadDir(dir)) {
    if (entry.isFile() && isSalExecutableName(entry.name)) {
      await fs.promises
        .chmod(path.join(dir, entry.name), 0o755)
        .catch(() => undefined);
    }
  }
}

async function requestJson(url) {
  const body = await requestBuffer(url);
  return JSON.parse(body.toString("utf8"));
}

function requestBuffer(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, requestHeaders(), (response) => {
      if (isRedirect(response.statusCode)) {
        response.resume();
        const location = new URL(response.headers.location, url).toString();
        requestBuffer(location).then(resolve, reject);
        return;
      }

      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks);

        if (!isSuccess(response.statusCode)) {
          let message = body.toString("utf8");
          try {
            message = JSON.parse(message).message || message;
          } catch {
            // Keep the raw response body.
          }
          reject(
            new Error(`GitHub returned HTTP ${response.statusCode}: ${message}`)
          );
          return;
        }

        resolve(body);
      });
    });

    request.on("error", reject);
  });
}

function requestHeaders() {
  return {
    "User-Agent": "sal-tools-vscode-extension",
    Accept: "application/vnd.github+json",
  };
}

function isSuccess(statusCode) {
  return statusCode >= 200 && statusCode < 300;
}

function isRedirect(statusCode) {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function isArchive(name) {
  return /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/.test(name);
}

function isChecksum(name) {
  return /\.(sha256|sha512|sha256sum|sha512sum|sig|asc)$/.test(
    name.toLowerCase()
  );
}

function isSalExecutableName(name) {
  return /^(sal-[\w-]+|sal2bool|ltl2buchi)(\.exe)?$/.test(name);
}

function sanitizePathSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "-");
}

function formatBytes(bytes) {
  if (!bytes) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
