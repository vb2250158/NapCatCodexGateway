import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

export type LanAgentReleaseFile = {
  path: string;
  sha256: string;
  size: number;
  downloadUrl: string;
};

export type LanAgentReleaseManifest = {
  version: string;
  platform: "node";
  minNodeVersion: string;
  files: LanAgentReleaseFile[];
  publicKey: string;
  publicKeySha256: string;
  signature: string;
};

type SigningKeyRecord = {
  publicKey: string;
  privateKey: string;
};

type ReleaseManifestPayload = Pick<LanAgentReleaseManifest, "version" | "platform" | "minNodeVersion" | "files">;

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function lanAgentReleasePublicKeySha256(publicKey: string): string {
  const der = createPublicKey(publicKey).export({ type: "spki", format: "der" });
  return sha256(der);
}

function requiredString(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function normalizeAssetPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`Invalid LAN Agent release asset path: ${value}`);
  }
  return normalized;
}

function manifestPayload(manifest: ReleaseManifestPayload): string {
  return JSON.stringify({
    version: manifest.version,
    platform: manifest.platform,
    minNodeVersion: manifest.minNodeVersion,
    files: manifest.files.map(file => ({
      path: file.path,
      sha256: file.sha256,
      size: file.size,
      downloadUrl: file.downloadUrl
    }))
  });
}

function readJson(filePath: string): Record<string, unknown> {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`LAN Agent release metadata is invalid: ${filePath}`);
  }
  return raw as Record<string, unknown>;
}

function readSigningKeys(filePath: string): SigningKeyRecord {
  if (fs.existsSync(filePath)) {
    const raw = readJson(filePath);
    return {
      publicKey: requiredString(raw.publicKey, "LAN Agent release publicKey"),
      privateKey: requiredString(raw.privateKey, "LAN Agent release privateKey")
    };
  }
  const pair = generateKeyPairSync("ed25519");
  const record: SigningKeyRecord = {
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    recordDataMutationAudit({
      level: "error",
      group: "lan-agent",
      event: "lan_agent_signing_key_create_failed",
      owner: "lan-agent-release",
      action: "create-signing-key",
      target: { type: "signing-key", id: "lan-agent-release" },
      dataSource: { kind: "file", id: path.basename(filePath) },
      outcome: "failed",
      error
    });
    throw error;
  }
  recordDataMutationAudit({
    group: "lan-agent",
    event: "lan_agent_signing_key_created",
    owner: "lan-agent-release",
    action: "create-signing-key",
    target: { type: "signing-key", id: "lan-agent-release" },
    dataSource: { kind: "file", id: path.basename(filePath) },
    outcome: "committed",
    after: { digest: lanAgentReleasePublicKeySha256(record.publicKey) }
  });
  return record;
}

function collectReleaseAssetPaths(root: string, relative = ""): string[] {
  const directory = path.join(root, relative);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (child === "node_modules" || child === "test") return [];
      return collectReleaseAssetPaths(root, child);
    }
    if (!entry.isFile()) return [];
    if (entry.name === "package.json" || entry.name.endsWith(".mjs") || (child.startsWith("dist/agent-hooks/") && /\.(json|md)$/.test(entry.name))) return [normalizeAssetPath(child)];
    return [];
  });
}

export function verifyLanAgentReleaseManifest(manifest: LanAgentReleaseManifest, expectedPublicKeySha256: string): boolean {
  try {
    const actualPublicKeySha256 = lanAgentReleasePublicKeySha256(manifest.publicKey);
    if (actualPublicKeySha256 !== expectedPublicKeySha256.toLowerCase() || manifest.publicKeySha256 !== actualPublicKeySha256) {
      return false;
    }
    const payload = manifestPayload(manifest);
    return verify(null, Buffer.from(payload), manifest.publicKey, Buffer.from(manifest.signature, "base64"));
  } catch {
    return false;
  }
}

export class LanAgentReleaseStore {
  private readonly rootDir: string;
  private readonly agentRoot: string;
  private readonly signingKeyPath: string;

  constructor(options: { rootDir: string; agentRoot?: string; signingKeyPath?: string }) {
    this.rootDir = path.resolve(options.rootDir);
    this.agentRoot = path.resolve(options.agentRoot ?? path.join(this.rootDir, "apps", "rabi-agent"));
    this.signingKeyPath = path.resolve(options.signingKeyPath ?? path.join(this.rootDir, "data", "lan-agent-release-signing-key.json"));
  }

  manifest(): LanAgentReleaseManifest {
    const packageJsonPath = path.join(this.agentRoot, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      throw new Error(`Rabi Agent package metadata is missing: ${packageJsonPath}`);
    }
    const packageJson = readJson(packageJsonPath);
    const version = requiredString(packageJson.version, "Rabi Agent package version");
    const files = collectReleaseAssetPaths(this.agentRoot)
      .sort((left, right) => left.localeCompare(right))
      .map(assetPath => {
        const file = fs.readFileSync(this.resolveAssetPath(assetPath));
        return {
          path: assetPath,
          sha256: sha256(file),
          size: file.byteLength,
          downloadUrl: `/api/lan-agent/releases/${encodeURIComponent(version)}/node/${assetPath.split("/").map(encodeURIComponent).join("/")}`
        };
      });
    if (!files.some(file => file.path === "rabi-agent.mjs")) {
      throw new Error("Rabi Agent release is missing rabi-agent.mjs.");
    }
    const keys = readSigningKeys(this.signingKeyPath);
    const unsigned: ReleaseManifestPayload = {
      version,
      platform: "node",
      minNodeVersion: "22.13.0",
      files
    };
    return {
      ...unsigned,
      publicKey: keys.publicKey,
      publicKeySha256: lanAgentReleasePublicKeySha256(keys.publicKey),
      signature: sign(null, Buffer.from(manifestPayload(unsigned)), keys.privateKey).toString("base64")
    };
  }

  readAsset(version: string, platform: string, assetPath: string): Buffer {
    const manifest = this.manifest();
    if (version !== manifest.version) throw new Error(`Rabi Agent release version is not available: ${version}`);
    if (platform !== manifest.platform) throw new Error(`Rabi Agent release platform is not available: ${platform}`);
    const normalizedPath = normalizeAssetPath(assetPath);
    if (!manifest.files.some(file => file.path === normalizedPath)) {
      throw new Error(`Rabi Agent release asset is not available: ${normalizedPath}`);
    }
    return fs.readFileSync(this.resolveAssetPath(normalizedPath));
  }

  private resolveAssetPath(assetPath: string): string {
    const normalizedPath = normalizeAssetPath(assetPath);
    const resolved = path.resolve(this.agentRoot, ...normalizedPath.split("/"));
    const relative = path.relative(this.agentRoot, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Rabi Agent release asset escapes its package root: ${assetPath}`);
    }
    return resolved;
  }
}
