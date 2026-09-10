const generatedDirectories = new Set([
  "node_modules", "dist", "data", ".git", ".runtime", "__pycache__", ".pytest_cache", "bin", "obj"
]);

export function skipArchitectureDirectory(name, relativePath) {
  if (generatedDirectories.has(name) || /^\.venv(?:-|$)/.test(name)) return true;
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.startsWith("desktop/rabi-voice-client/") && /^(?:build|dist)(?:-|$)/.test(name);
}
