#!/usr/bin/env node
/**
 * Configure an Elastic Workflows MCP server entry in supported MCP clients.
 *
 * Targets Cursor, Claude Code, and Claude Desktop. Uses `mcp-remote` to bridge
 * Kibana's HTTP MCP transport into a stdio MCP client and injects the Kibana
 * auth header from environment variables (no secrets are written to disk).
 *
 * The MCP endpoint is filtered to a single namespace (default `platform.workflows`)
 * so only workflow authoring tools surface in the agent.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

try {
  process.loadEnvFile();
} catch {}

const DEFAULT_NAME = "elastic-workflows";
const DEFAULT_NAMESPACE = "platform.workflows";

const SUPPORTED_CLIENTS = ["cursor", "claude-code", "claude-desktop"];

function parseArgs(argv) {
  const result = { clients: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    if (arg === "--client") {
      const value = argv[++i];
      if (!value) {
        console.error("Error: --client requires a value.");
        process.exit(1);
      }
      result.clients.push(value);
      continue;
    }
    if (arg === "--name") {
      result.name = argv[++i];
      continue;
    }
    if (arg === "--namespace") {
      result.namespace = argv[++i];
      continue;
    }
    if (arg === "--url") {
      result.url = argv[++i];
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    console.error(`Error: Unknown argument "${arg}".`);
    process.exit(1);
  }
  return result;
}

function printHelp() {
  console.log(`Usage: setup-mcp.js [options]

Configures an MCP server entry pointing at Kibana's Agent Builder MCP endpoint,
filtered to workflow authoring tools.

Options:
  --client <name>       Target client: cursor, claude-code, claude-desktop.
                        Repeatable. If omitted, all detected clients are updated.
  --name <name>         MCP server entry name (default: ${DEFAULT_NAME}).
  --namespace <ns>      Comma-separated namespace filter
                        (default: ${DEFAULT_NAMESPACE}).
  --url <url>           Override the Kibana base URL (defaults to KIBANA_URL).
  --dry-run             Print the resulting MCP server JSON, do not write files.
  -h, --help            Show this help.

Environment:
  KIBANA_URL            Kibana base URL (required unless --url is given).
  KIBANA_API_KEY        API key for the auth header (preferred).
  KIBANA_USERNAME / KIBANA_PASSWORD
                        Basic auth fallback if no API key is set.
`);
}

function getKibanaUrl(opts) {
  const url = opts.url || process.env.KIBANA_URL;
  if (!url) {
    console.error("Error: KIBANA_URL is not set. Pass --url or export KIBANA_URL.");
    process.exit(1);
  }
  return url.replace(/\/$/, "");
}

function buildMcpUrl(opts) {
  const base = getKibanaUrl(opts);
  const namespace = opts.namespace || DEFAULT_NAMESPACE;
  const search = new URLSearchParams({ namespace });
  return `${base}/api/agent_builder/mcp?${search.toString()}`;
}

function buildAuthHeader() {
  const apiKey = process.env.KIBANA_API_KEY;
  if (apiKey) {
    return "Authorization:ApiKey ${env:KIBANA_API_KEY}";
  }
  const username = process.env.KIBANA_USERNAME || process.env.ELASTICSEARCH_USERNAME;
  const password = process.env.KIBANA_PASSWORD || process.env.ELASTICSEARCH_PASSWORD;
  if (username && password) {
    const encoded = Buffer.from(`${username}:${password}`).toString("base64");
    return `Authorization:Basic ${encoded}`;
  }
  console.error(
    "Error: No Kibana auth configured. Set KIBANA_API_KEY or KIBANA_USERNAME + KIBANA_PASSWORD before running setup."
  );
  process.exit(1);
}

function buildServerEntry(opts) {
  const mcpUrl = buildMcpUrl(opts);
  const authHeader = buildAuthHeader();
  return {
    type: "stdio",
    command: "npx",
    args: ["-y", "mcp-remote", mcpUrl, "--header", authHeader],
  };
}

function configPathFor(client) {
  switch (client) {
    case "cursor":
      return path.join(os.homedir(), ".cursor", "mcp.json");
    case "claude-code":
      return path.join(os.homedir(), ".claude.json");
    case "claude-desktop":
      if (process.platform === "darwin") {
        return path.join(
          os.homedir(),
          "Library",
          "Application Support",
          "Claude",
          "claude_desktop_config.json"
        );
      }
      if (process.platform === "win32") {
        return path.join(
          process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
          "Claude",
          "claude_desktop_config.json"
        );
      }
      return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
    default:
      return null;
  }
}

function detectClients() {
  const detected = [];
  for (const client of SUPPORTED_CLIENTS) {
    const configPath = configPathFor(client);
    if (configPath && fs.existsSync(configPath)) {
      detected.push(client);
    }
  }
  return detected;
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse JSON at ${filePath}: ${error.message}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function applyEntry(client, name, entry, configPath) {
  const config = readJson(configPath);
  config.mcpServers = config.mcpServers || {};
  const previous = config.mcpServers[name];
  config.mcpServers[name] = entry;

  writeJson(configPath, config);

  if (previous) {
    console.log(`  ${client}: updated entry "${name}" in ${configPath}`);
  } else {
    console.log(`  ${client}: added entry "${name}" to ${configPath}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const name = opts.name || DEFAULT_NAME;
  const entry = buildServerEntry(opts);
  const mcpUrl = buildMcpUrl(opts);

  console.log(`Elastic MCP endpoint: ${mcpUrl}`);
  console.log(`Server entry name:    ${name}`);
  console.log("");

  if (opts.dryRun) {
    console.log("Dry run — would write the following MCP server entry:");
    console.log(JSON.stringify({ [name]: entry }, null, 2));
    return;
  }

  let clients = opts.clients.length ? opts.clients : detectClients();
  for (const client of clients) {
    if (!SUPPORTED_CLIENTS.includes(client)) {
      console.error(`Skipping "${client}": unknown client.`);
      continue;
    }
  }
  clients = clients.filter((c) => SUPPORTED_CLIENTS.includes(c));

  if (clients.length === 0) {
    console.log(
      "No supported MCP clients detected (cursor, claude-code, claude-desktop). Pass --client to target one explicitly."
    );
    return;
  }

  console.log(`Targeting clients: ${clients.join(", ")}`);
  for (const client of clients) {
    const configPath = configPathFor(client);
    if (!configPath) {
      console.error(`  ${client}: no known config path on this platform.`);
      continue;
    }
    try {
      applyEntry(client, name, entry, configPath);
    } catch (error) {
      console.error(`  ${client}: ${error.message}`);
    }
  }

  console.log("");
  console.log("Done. Restart your MCP client to pick up the new server entry.");
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
