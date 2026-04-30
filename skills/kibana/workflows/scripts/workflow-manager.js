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

import fs from "node:fs";
import path from "node:path";

import {
  kibanaGet,
  kibanaPost,
  kibanaPut,
  kibanaDelete,
  kibanaFetch,
} from "./kibana-client.js";

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-/g, "_");
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        result[key] = next;
        i++;
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}

const WORKFLOWS_BASE = "/api/workflows";
const WORKFLOW_BASE = "/api/workflows/workflow";

function readYamlFile(filePath) {
  if (!filePath) {
    console.error("Error: --file is required.");
    process.exit(1);
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: File not found: ${resolved}`);
    process.exit(1);
  }
  return fs.readFileSync(resolved, "utf8");
}

function parseInputs(raw) {
  if (raw === undefined) return {};
  if (typeof raw !== "string") return {};
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
  if (args.tags) params.tags = args.tags.split(",").map((t) => t.trim());

  const data = await kibanaGet(WORKFLOWS_BASE, params);
  const results = data.results || data || [];
  console.log(`Workflows (${results.length}):`);
  console.log("");
  if (results.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const workflow of results) {
    const enabled = workflow.enabled ? "enabled" : "disabled";
    const valid = workflow.valid === false ? "  [INVALID]" : "";
    const tags = workflow.tags && workflow.tags.length ? `  [${workflow.tags.join(", ")}]` : "";
    console.log(`  ${workflow.id}\t${workflow.name}\t${enabled}${tags}${valid}`);
  }
}

async function getWorkflow(args) {
  if (!args.id) {
    console.error("Error: --id is required.");
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
    method: "POST",
    body: JSON.stringify({ yaml }),
    headers: {
      "elastic-api-version": "1",
      "x-elastic-internal-origin": "elastic-workflows-skill",
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
    console.log("Workflow YAML is valid.");
    return;
  }
  console.log("Workflow YAML is INVALID.");
  for (const diagnostic of validation.diagnostics || []) {
    const where = diagnostic.path && diagnostic.path.length ? ` (at ${diagnostic.path.join(".")})` : "";
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
  console.log(`Workflow created successfully. ID: ${result?.id || "(unknown)"}`);
  console.log(JSON.stringify(result, null, 2));
}

async function runWorkflow(args) {
  if (!args.id) {
    console.error("Error: --id is required.");
    process.exit(1);
  }
  const inputs = parseInputs(args.inputs);
  const result = await kibanaPost(`${WORKFLOW_BASE}/${encodeURIComponent(args.id)}/run`, { inputs });
  console.log(`Run started. Execution ID: ${result?.workflowExecutionId || "(unknown)"}`);
  console.log(JSON.stringify(result, null, 2));
}

async function testWorkflow(args) {
  const inputs = parseInputs(args.inputs);
  const payload = { inputs };
  if (args.id) payload.workflowId = args.id;
  if (args.file) payload.workflowYaml = readYamlFile(args.file);
  if (!payload.workflowId && !payload.workflowYaml) {
    console.error("Error: pass --file, --id, or both.");
    process.exit(1);
  }
  const result = await kibanaPost(`${WORKFLOWS_BASE}/test`, payload);
  console.log(`Test run started. Execution ID: ${result?.workflowExecutionId || "(unknown)"}`);
  console.log(JSON.stringify(result, null, 2));
}

async function deleteWorkflow(args) {
  if (!args.id) {
    console.error("Error: --id is required.");
    process.exit(1);
  }
  await kibanaDelete(`${WORKFLOW_BASE}/${encodeURIComponent(args.id)}`);
  console.log(`Workflow "${args.id}" deleted successfully.`);
}

function printHelp() {
  console.error(`Usage: workflow-manager.js <command> [options]

Commands:
  list                                       List workflows
  get --id <id>                              Get a single workflow
  validate --file <path>                     Validate a local YAML against Kibana
  deploy --file <path> [--id <id>]           Create or update a workflow from a local YAML
  run --id <id> [--inputs <json>]            Run a deployed workflow
  test [--file <path>] [--id <id>] [--inputs <json>]
                                             Run an unsaved draft (or saved workflow) without saving
  delete --id <id>                           Delete a workflow

Common options:
  --file        Path to a workflow YAML file
  --id          Workflow ID
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
    case "list":
      await listWorkflows(args);
      break;
    case "get":
      await getWorkflow(args);
      break;
    case "validate":
      await validateWorkflowFile(args);
      break;
    case "deploy":
      await deployWorkflow(args);
      break;
    case "run":
      await runWorkflow(args);
      break;
    case "test":
      await testWorkflow(args);
      break;
    case "delete":
      await deleteWorkflow(args);
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
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
