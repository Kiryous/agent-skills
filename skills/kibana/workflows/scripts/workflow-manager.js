#!/usr/bin/env node
/**
 * Workflow lifecycle CLI for Elastic Workflows.
 *
 * Wraps Kibana's public workflows REST API: list, get, validate, deploy
 * (create / update from a local YAML file), run, test (run an unsaved draft),
 * and delete. Authoring and validation should also be available to the agent
 * directly via the platform.workflows.* MCP tools — this CLI is the deploy
 * and run side of the loop.
 */

import fs from 'node:fs';
import path from 'node:path';

import { kibanaGet, kibanaPost, kibanaPut, kibanaDelete, kibanaFetch } from './kibana-client.js';

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-/g, '_');
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        result[key] = next;
        i++;
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}

const WORKFLOWS_BASE = '/api/workflows';
const WORKFLOW_BASE = '/api/workflows/workflow';
const EXECUTIONS_BASE = '/api/workflows/executions';

const TERMINAL_EXECUTION_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'skipped',
  'timed_out',
]);

function readYamlFile(filePath) {
  if (!filePath) {
    console.error('Error: --file is required.');
    process.exit(1);
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: File not found: ${resolved}`);
    process.exit(1);
  }
  return fs.readFileSync(resolved, 'utf8');
}

function parseInputs(raw) {
  if (raw === undefined) return {};
  if (typeof raw !== 'string') return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`Error: --inputs must be valid JSON. ${error.message}`);
    process.exit(1);
  }
}

async function listWorkflows(args) {
  const params = {};
  if (args.query) params.query = args.query;
  if (args.size) params.size = Number(args.size);
  if (args.page) params.page = Number(args.page);
  if (args.tags) params.tags = args.tags.split(',').map((t) => t.trim());

  const data = await kibanaGet(WORKFLOWS_BASE, params);
  const results = data.results || data || [];
  console.log(`Workflows (${results.length}):`);
  console.log('');
  if (results.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const workflow of results) {
    const enabled = workflow.enabled ? 'enabled' : 'disabled';
    const valid = workflow.valid === false ? '  [INVALID]' : '';
    const tags = workflow.tags && workflow.tags.length ? `  [${workflow.tags.join(', ')}]` : '';
    console.log(`  ${workflow.id}\t${workflow.name}\t${enabled}${tags}${valid}`);
  }
}

async function getWorkflow(args) {
  if (!args.id) {
    console.error('Error: --id is required.');
    process.exit(1);
  }
  const data = await kibanaGet(`${WORKFLOW_BASE}/${encodeURIComponent(args.id)}`);
  console.log(JSON.stringify(data, null, 2));
}

async function validateWorkflowFile(args) {
  const yaml = readYamlFile(args.file);
  // Internal endpoint — needs the elastic-api-version header and
  // x-elastic-internal-origin so Kibana accepts the request from a
  // non-browser caller.
  const result = await kibanaFetch(`${WORKFLOWS_BASE}/validate`, {
    method: 'POST',
    body: JSON.stringify({ yaml }),
    headers: {
      'elastic-api-version': '1',
      'x-elastic-internal-origin': 'elastic-workflows-skill',
    },
  });
  if (!result.success) {
    console.error(`Validation request failed (HTTP ${result.status}): ${result.error}`);
    if (result.details) {
      console.error(JSON.stringify(result.details, null, 2));
    }
    process.exit(1);
  }
  const validation = result.data;
  if (validation.valid) {
    console.log('Workflow YAML is valid.');
    return;
  }
  console.log('Workflow YAML is INVALID.');
  for (const diagnostic of validation.diagnostics || []) {
    const where =
      diagnostic.path && diagnostic.path.length ? ` (at ${diagnostic.path.join('.')})` : '';
    console.log(`  [${diagnostic.severity}] [${diagnostic.source}] ${diagnostic.message}${where}`);
  }
  process.exit(1);
}

async function deployWorkflow(args) {
  const yaml = readYamlFile(args.file);
  if (args.id) {
    const result = await kibanaPut(`${WORKFLOW_BASE}/${encodeURIComponent(args.id)}`, { yaml });
    console.log(`Workflow "${args.id}" updated successfully.`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const payload = { yaml };
  if (args.new_id) {
    payload.id = args.new_id;
  }
  const result = await kibanaPost(`${WORKFLOW_BASE}`, payload);
  console.log(`Workflow created successfully. ID: ${result?.id || '(unknown)'}`);
  console.log(JSON.stringify(result, null, 2));
}

async function runWorkflow(args) {
  if (!args.id) {
    console.error('Error: --id is required.');
    process.exit(1);
  }
  const inputs = parseInputs(args.inputs);
  const result = await kibanaPost(`${WORKFLOW_BASE}/${encodeURIComponent(args.id)}/run`, {
    inputs,
  });
  console.log(`Run started. Execution ID: ${result?.workflowExecutionId || '(unknown)'}`);
  console.log(JSON.stringify(result, null, 2));
}

async function testWorkflow(args) {
  const inputs = parseInputs(args.inputs);
  const payload = { inputs };
  if (args.id) payload.workflowId = args.id;
  if (args.file) payload.workflowYaml = readYamlFile(args.file);
  if (!payload.workflowId && !payload.workflowYaml) {
    console.error('Error: pass --file, --id, or both.');
    process.exit(1);
  }
  const result = await kibanaPost(`${WORKFLOWS_BASE}/test`, payload);
  console.log(`Test run started. Execution ID: ${result?.workflowExecutionId || '(unknown)'}`);
  console.log(JSON.stringify(result, null, 2));
}

async function deleteWorkflow(args) {
  if (!args.id) {
    console.error('Error: --id is required.');
    process.exit(1);
  }
  await kibanaDelete(`${WORKFLOW_BASE}/${encodeURIComponent(args.id)}`);
  console.log(`Workflow "${args.id}" deleted successfully.`);
}

async function listExecutions(args) {
  if (!args.workflow_id) {
    console.error('Error: --workflow-id is required.');
    process.exit(1);
  }
  const params = {};
  if (args.statuses) params.statuses = args.statuses.split(',').map((s) => s.trim());
  if (args.execution_types) {
    params.executionTypes = args.execution_types.split(',').map((t) => t.trim());
  }
  if (args.size) params.size = Number(args.size);
  if (args.page) params.page = Number(args.page);
  if (args.omit_step_runs !== undefined) params.omitStepRuns = true;

  const data = await kibanaGet(
    `${WORKFLOW_BASE}/${encodeURIComponent(args.workflow_id)}/executions`,
    params
  );
  const results = data.results || data._source?.results || data || [];
  console.log(`Executions for workflow "${args.workflow_id}" (${results.length}):`);
  console.log('');
  if (results.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const execution of results) {
    const status = execution.status || '(unknown)';
    const startedAt = execution.startedAt || execution.createdAt || '';
    const triggeredBy = execution.triggeredBy || execution.executedBy || '';
    console.log(
      `  ${execution.id}\t${status}\t${startedAt}${triggeredBy ? `\t(by ${triggeredBy})` : ''}`
    );
  }
}

async function getExecution(args) {
  if (!args.id) {
    console.error('Error: --id is required.');
    process.exit(1);
  }
  const params = {};
  if (args.include_input) params.includeInput = true;
  if (args.include_output) params.includeOutput = true;
  const data = await kibanaGet(
    `${EXECUTIONS_BASE}/${encodeURIComponent(args.id)}`,
    Object.keys(params).length ? params : undefined
  );
  console.log(JSON.stringify(data, null, 2));
}

async function getExecutionLogs(args) {
  const executionId = args.execution_id || args.id;
  if (!executionId) {
    console.error('Error: --execution-id is required.');
    process.exit(1);
  }
  const params = {};
  if (args.step_execution_id) params.stepExecutionId = args.step_execution_id;
  if (args.size) params.size = Number(args.size);
  if (args.page) params.page = Number(args.page);
  if (args.sort_field) params.sortField = args.sort_field;
  if (args.sort_order) params.sortOrder = args.sort_order;

  const data = await kibanaGet(
    `${EXECUTIONS_BASE}/${encodeURIComponent(executionId)}/logs`,
    Object.keys(params).length ? params : undefined
  );
  const entries = data.logs || data.results || data || [];
  console.log(`Logs for execution "${executionId}" (${entries.length}):`);
  console.log('');
  if (entries.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const entry of entries) {
    const ts = entry['@timestamp'] || entry.timestamp || '';
    const level = entry.level || entry.log?.level || 'info';
    const message = entry.message || JSON.stringify(entry);
    console.log(`  [${ts}] [${level.toUpperCase()}] ${message}`);
  }
}

async function pollExecution(args) {
  if (!args.id) {
    console.error('Error: --id is required.');
    process.exit(1);
  }
  const timeoutMs = Number(args.timeout || 60) * 1000;
  const intervalMs = Number(args.interval || 2) * 1000;
  const start = Date.now();

  let last;
  while (Date.now() - start < timeoutMs) {
    const data = await kibanaGet(`${EXECUTIONS_BASE}/${encodeURIComponent(args.id)}`);
    const status = data.status || '(unknown)';
    if (last !== status) {
      console.log(`  status=${status}\t(${Math.round((Date.now() - start) / 1000)}s)`);
      last = status;
    }
    if (TERMINAL_EXECUTION_STATUSES.has(status)) {
      console.log('');
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  console.error(
    `Timed out after ${timeoutMs / 1000}s waiting for execution "${args.id}" to reach a terminal state.`
  );
  process.exit(1);
}

function printHelp() {
  console.error(`Usage: workflow-manager.js <command> [options]

Workflow commands:
  list                                       List workflows
  get --id <id>                              Get a single workflow
  validate --file <path>                     Validate a local YAML against Kibana
  deploy --file <path> [--id <id>]           Create or update a workflow from a local YAML
  run --id <id> [--inputs <json>]            Run a deployed workflow
  test [--file <path>] [--id <id>] [--inputs <json>]
                                             Run an unsaved draft (or saved workflow) without saving
  delete --id <id>                           Delete a workflow

Execution-inspection commands:
  executions --workflow-id <id> [--statuses <s1,s2>] [--execution-types <t1,t2>]
             [--page <n>] [--size <n>] [--omit-step-runs]
                                             List executions for a workflow
  execution --id <execution_id> [--include-input] [--include-output]
                                             Get details for a single execution
  poll --id <execution_id> [--timeout <s>] [--interval <s>]
                                             Poll an execution until it reaches a terminal state
  logs --execution-id <id> [--step-execution-id <id>]
       [--page <n>] [--size <n>] [--sort-field <f>] [--sort-order <asc|desc>]
                                             Fetch paginated logs for an execution

Common options:
  --file        Path to a workflow YAML file
  --id          Workflow ID (or execution ID for execution / poll)
  --new-id      Optional custom ID when creating a new workflow with deploy
  --inputs      JSON string of workflow inputs
  --query       Free-text search query (list)
  --size, --page, --tags                     Pagination and filters (list)

Environment:
  KIBANA_URL, KIBANA_API_KEY (or KIBANA_USERNAME + KIBANA_PASSWORD),
  KIBANA_SPACE_ID, KIBANA_INSECURE
`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case 'list':
      await listWorkflows(args);
      break;
    case 'get':
      await getWorkflow(args);
      break;
    case 'validate':
      await validateWorkflowFile(args);
      break;
    case 'deploy':
      await deployWorkflow(args);
      break;
    case 'run':
      await runWorkflow(args);
      break;
    case 'test':
      await testWorkflow(args);
      break;
    case 'delete':
      await deleteWorkflow(args);
      break;
    case 'executions':
      await listExecutions(args);
      break;
    case 'execution':
      await getExecution(args);
      break;
    case 'poll':
      await pollExecution(args);
      break;
    case 'logs':
      await getExecutionLogs(args);
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
