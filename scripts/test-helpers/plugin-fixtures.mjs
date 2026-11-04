// Fixture captured from a real VS Code `agentPlugins` tree (roadmap step 1.1).
//
// Naming rule observed on this machine:
// - VS Code stores each plugin location's snapshots in a directory named
//   `file-` + the location path with `/` replaced by `-` and the leading `/`
//   dropped (e.g. `file:///home/david/DP/agento-plugin` ->
//   `file-home-david-DP-agento-plugin`).
// - `cache.json` records one `nonce` per snapshot; each nonce is a hex-named
//   snapshot directory whose nonce equals the hex millisecond mtime of the
//   location directory at snapshot time.

export const uriToDirExamples = [
  ["file:///home/david/DP/agento-plugin", "file-home-david-DP-agento-plugin"],
  ["vscode-synced-customization:/agent-host-claude--145374629", "vscode-synced-customization-agent-host-claude-145374629"],
];

// The seven snapshot nonces observed for the Agento plugin location on the
// build machine, oldest to newest. The newest (largest) equals
// hex(Math.floor(mtimeMs)) of the plugin location directory.
export const snapshotNonces = [
  "1a14d7020a8",
  "1a16a70f607",
  "1a16ef0c88f",
  "1a173994d66",
  "1a1743ed22d",
  "1a18e5b18c2",
  "1a194a81a45",
];

export const newestNonce = "1a194a81a45";
