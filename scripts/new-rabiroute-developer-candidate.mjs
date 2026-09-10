import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { writeManifest } from "./create-windows-release-manifest.mjs";

function requireFile(root, relativePath) {
  const target = path.join(root, ...relativePath.split("/"));
  if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Developer candidate input is missing: ${relativePath}`);
  }
  return target;
}

function replaceDirectory(source, destination) {
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Developer candidate input directory is missing: ${source}`);
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, dereference: false, errorOnExist: false });
}

function createDeveloperCandidate(options) {
  const baseRoot = path.resolve(options.baseRoot);
  const buildRoot = path.resolve(options.buildRoot);
  const traySourceRoot = path.resolve(options.traySourceRoot);
  const hostCoreRoot = path.resolve(options.hostCoreRoot);
  const versionsRoot = path.resolve(options.versionsRoot);
  const packageVersion = String(options.packageVersion ?? "").trim();
  if (!packageVersion) throw new Error("Developer candidate packageVersion is required.");
  for (const root of [baseRoot, buildRoot, traySourceRoot, hostCoreRoot]) {
    if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Developer candidate root is missing: ${root}`);
    }
  }
  requireFile(baseRoot, "node.exe");
  requireFile(buildRoot, "dist/manager.js");
  requireFile(buildRoot, "ribiwebgui/dist/index.html");
  requireFile(traySourceRoot, "main.py");
  requireFile(hostCoreRoot, "RabiRouteHost.Core.dll");

  fs.mkdirSync(versionsRoot, { recursive: true });
  const stagingRoot = path.join(versionsRoot, `.developer-staging-${randomUUID()}`);
  try {
    fs.cpSync(baseRoot, stagingRoot, { recursive: true, dereference: false, errorOnExist: true });
    fs.rmSync(path.join(stagingRoot, "release-manifest.json"), { force: true });
    replaceDirectory(path.join(buildRoot, "dist"), path.join(stagingRoot, "dist"));
    replaceDirectory(path.join(buildRoot, "ribiwebgui", "dist"), path.join(stagingRoot, "ribiwebgui", "dist"));
    replaceDirectory(path.join(buildRoot, "assets"), path.join(stagingRoot, "assets"));
    if (fs.statSync(path.join(buildRoot, "apps", "rabi-agent"), { throwIfNoEntry: false })?.isDirectory()) {
      replaceDirectory(path.join(buildRoot, "apps", "rabi-agent"), path.join(stagingRoot, "apps", "rabi-agent"));
    }
    // Runtime context links and plugin entrypoints must match the new Manager build.
    for (const name of ["docs", "plugins", "skills", "source-patches"]) {
      replaceDirectory(path.join(buildRoot, name), path.join(stagingRoot, name));
    }
    for (const name of ["README.md", "README_zh.md", "版本更新日志.md", "版本更新日志_en.md"]) {
      fs.copyFileSync(requireFile(buildRoot, name), path.join(stagingRoot, name));
    }
    if (fs.statSync(path.join(buildRoot, "scripts"), { throwIfNoEntry: false })?.isDirectory()) {
      replaceDirectory(path.join(buildRoot, "scripts"), path.join(stagingRoot, "scripts"));
    }
    replaceDirectory(traySourceRoot, path.join(stagingRoot, "desktop-runtime"));
    for (const name of ["RabiRouteHost.Core.dll", "RabiRouteHost.Core.deps.json"]) {
      const source = path.join(hostCoreRoot, name);
      if (fs.statSync(source, { throwIfNoEntry: false })?.isFile()) {
        fs.copyFileSync(source, path.join(stagingRoot, name));
      }
    }
    const manifest = writeManifest(stagingRoot, packageVersion);
    const packageRoot = path.join(versionsRoot, manifest.releaseId);
    if (fs.existsSync(packageRoot)) {
      const existing = JSON.parse(fs.readFileSync(path.join(packageRoot, "release-manifest.json"), "utf8"));
      if (existing.payloadSha256 !== manifest.payloadSha256) {
        throw new Error(`Developer releaseId collision: ${manifest.releaseId}`);
      }
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    } else {
      fs.renameSync(stagingRoot, packageRoot);
    }
    return Object.freeze({
      packageRoot,
      releaseId: manifest.releaseId,
      payloadSha256: manifest.payloadSha256,
      manifest
    });
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(`Invalid argument: ${name ?? ""}`);
    values.set(name, value);
  }
  const required = ["--base", "--build", "--tray", "--host-core", "--versions", "--version"];
  for (const name of required) if (!values.get(name)) throw new Error(`Missing argument: ${name}`);
  return {
    baseRoot: values.get("--base"),
    buildRoot: values.get("--build"),
    traySourceRoot: values.get("--tray"),
    hostCoreRoot: values.get("--host-core"),
    versionsRoot: values.get("--versions"),
    packageVersion: values.get("--version")
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = createDeveloperCandidate(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      packageRoot: result.packageRoot,
      releaseId: result.releaseId,
      payloadSha256: result.payloadSha256
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export { createDeveloperCandidate };
