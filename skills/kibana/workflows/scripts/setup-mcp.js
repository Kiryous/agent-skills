#!/usr/bin/env node
/**
 * Configure an Elastic Workflows MCP server entry in supported MCP clients.
 *
 * Targets Cursor, Claude Code, and Claude Desktop. Uses `mcp-remote` to bridge
 * Kibana's HTTP MCP transport into a stdio MCP client and injects the Kibana
 * auth header from environment variables (no API-key secrets are written to
 * disk — Basic-auth credentials are inlined as a documented tradeoff).
 *
 * Auth precedence:
 *   1. KIBANA_API_KEY            — explicit, works for any deployment.
 *   2. ELASTICSEARCH_API_KEY     — Cloud Management skill handoff. The
 *                                  `cloud-manage-project` skill's
 *                                  `load-credentials` helper exports both
 *                                  KIBANA_URL and ELASTICSEARCH_API_KEY when
 *                                  the user runs:
 *                                      eval $(.../manage-project.py
 *                                             load-credentials --name <proj>)
 *                                  Kibana accepts the same `Authorization:
 *                                  ApiKey ...` header — the underlying API key
 *                                  just needs the `agentBuilder:read`
 *                                  privilege to call /api/agent_builder/mcp.
 *   3. KIBANA_USERNAME + KIBANA_PASSWORD (or ELASTICSEARCH_USERNAME +
 *      ELASTICSEARCH_PASSWORD)   — Basic-auth fallback for local dev.
 *
 * The MCP endpoint is filtered to a comma-separated list of namespaces so the
 * agent surface is limited to a curated set of workflow + platform tools. The
 * default exposes both workflow authoring tools and the broader `platform.core`
 * namespace, which already ships first-class tools we want to reuse:
 *
 *  - get_workflow_execution_status / resume_workflow_execution
 *  - get_index_mapping / list_indices / index_explorer
 *  - generate_esql / execute_esql
 *  - cases / product_documentation
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

try {
  process.loadEnvFile();
} catch {}

const DEFAULT_NAME = 'elastic-workflows';
const DEFAULT_NAMESPACE = 'platform.workflows,platform.core';

const SUPPORTED_CLIENTS = ['cursor', 'claude-code', 'claude-desktop'];

function parseArgs(argv) {
  const result = { clients: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      result.dryRun = true;
      continue;
    }
    if (arg === '--client') {
      const value = argv[++i];
      if (!value) {
        console.error('Error: --client requires a value.');
        process.exit(1);
      }
      result.clients.push(value);
      continue;
    }
    if (arg === '--name') {
      result.name = argv[++i];
      continue;
    }
    if (arg === '--namespace') {
      result.namespace = argv[++i];
      continue;
    }
    if (arg === '--url') {
      result.url = argv[++i];
      continue;
    }
    if (arg === '--help' || arg === '-h') {
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
                        (default: "${DEFAULT_NAMESPACE}"). Pass a narrower value
                        like "platform.workflows" if you want workflow tools
                        only, or "platform.workflows,platform.core,platform.streams"
                        for an even broader surface.
  --url <url>           Override the Kibana base URL (defaults to KIBANA_URL).
  --dry-run             Print the resulting MCP server JSON, do not write files.
  -h, --help            Show this help.

Environment:
  KIBANA_URL            Kibana base URL (required unless --url is given).
                        Auto-set by the cloud-manage-project skill's
                        \`eval $(... load-credentials --name <proj>)\`.
  KIBANA_API_KEY        Preferred. Explicit Kibana API key for the auth header.
  ELASTICSEARCH_API_KEY Cloud Management skill handoff — falls back to this
                        when KIBANA_API_KEY is not set. Auto-set by the same
                        cloud-manage-project \`load-credentials\` command. The
                        underlying API key needs \`agentBuilder:read\`.
  KIBANA_USERNAME / KIBANA_PASSWORD
                        Basic-auth fallback for local dev. Falls back to
                        ELASTICSEARCH_USERNAME / ELASTICSEARCH_PASSWORD.
`);
}

function getKibanaUrl(opts) {
  const url = opts.url || process.env.KIBANA_URL;
  if (!url) {
    console.error('Error: KIBANA_URL is not set. Pass --url or export KIBANA_URL.');
    process.exit(1);
  }
  return url.replace(/\/$/, '');
}

function buildMcpUrl(opts) {
  const base = getKibanaUrl(opts);
  const namespace = opts.namespace || DEFAULT_NAMESPACE;
  const search = new URLSearchParams({ namespace });
  return `${base}/api/agent_builder/mcp?${search.toString()}`;
}

function buildAuthHeader() {
  if (process.env.KIBANA_API_KEY) {
    return {
      header: 'Authorization:ApiKey ${env:KIBANA_API_KEY}',
      source: 'KIBANA_API_KEY env var',
    };
  }
  if (process.env.ELASTICSEARCH_API_KEY) {
    return {
      header: 'Authorization:ApiKey ${env:ELASTICSEARCH_API_KEY}',
      source: 'ELASTICSEARCH_API_KEY env var (Cloud Management skill handoff)',
    };
  }
  const username = process.env.KIBANA_USERNAME || process.env.ELASTICSEARCH_USERNAME;
  const password = process.env.KIBANA_PASSWORD || process.env.ELASTICSEARCH_PASSWORD;
  if (username && password) {
    const encoded = Buffer.from(`${username}:${password}`).toString('base64');
    return {
      header: `Authorization:Basic ${encoded}`,
      source: `Basic auth as "${username}" (inlined into MCP config)`,
    };
  }
  console.error(
    'Error: No Kibana auth configured. Set one of:\n' +
      '  - KIBANA_API_KEY (preferred)\n' +
      '  - ELASTICSEARCH_API_KEY (run `eval $(.../cloud/manage-project/scripts/manage-project.py load-credentials --name <project>)`\n' +
      '    from the cloud-manage-project skill, then ensure the underlying API key has `agentBuilder:read`)\n' +
      '  - KIBANA_USERNAME + KIBANA_PASSWORD (local dev only)'
  );
  process.exit(1);
}

function buildServerEntry(opts) {
  const mcpUrl = buildMcpUrl(opts);
  const auth = buildAuthHeader();
  return {
    entry: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-remote', mcpUrl, '--header', auth.header],
    },
    authSource: auth.source,
  };
}

function configPathFor(client) {
  switch (client) {
    case 'cursor':
      return path.join(os.homedir(), '.cursor', 'mcp.json');
    case 'claude-code':
      return path.join(os.homedir(), '.claude.json');
    case 'claude-desktop':
      if (process.platform === 'darwin') {
        return path.join(
          os.homedir(),
          'Library',
          'Application Support',
          'Claude',
          'claude_desktop_config.json'
        );
      }
      if (process.platform === 'win32') {
        return path.join(
          process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
          'Claude',
          'claude_desktop_config.json'
        );
      }
      return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
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
  const raw = fs.readFileSync(filePath, 'utf8').trim();
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
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
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
  const { entry, authSource } = buildServerEntry(opts);
  const mcpUrl = buildMcpUrl(opts);

  console.log(`Elastic MCP endpoint: ${mcpUrl}`);
  console.log(`Server entry name:    ${name}`);
  console.log(`Auth:                 ${authSource}`);
  console.log('');

  if (opts.dryRun) {
    console.log('Dry run — would write the following MCP server entry:');
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
      'No supported MCP clients detected (cursor, claude-code, claude-desktop). Pass --client to target one explicitly.'
    );
    return;
  }

  console.log(`Targeting clients: ${clients.join(', ')}`);
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

  console.log('');
  console.log('Done. Restart your MCP client to pick up the new server entry.');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Activate a trial license (one-off per cluster):');
  console.log(
    '     curl -u $KIBANA_USERNAME:$KIBANA_PASSWORD -X POST \\\n' +
      '       "${KIBANA_URL/5601/9200}/_license/start_trial?acknowledge=true"'
  );
  console.log('  2. Enable agentBuilder:experimentalFeatures (one-off per Kibana space):');
  console.log(
    '     curl -u $KIBANA_USERNAME:$KIBANA_PASSWORD -X POST \\\n' +
      '       "$KIBANA_URL/internal/kibana/settings/agentBuilder:experimentalFeatures" \\\n' +
      '       -H "Content-Type: application/json" -H "kbn-xsrf: true" \\\n' +
      '       -H "x-elastic-internal-origin: kibana" -d \'{"value": true}\''
  );
  console.log('  3. Restart your MCP client and verify with:');
  console.log('     node skills/kibana/workflows/scripts/smoke.js');
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
