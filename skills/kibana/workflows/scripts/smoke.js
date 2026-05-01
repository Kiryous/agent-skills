#!/usr/bin/env node
/**
 * End-to-end smoke test for the kibana-workflows skill.
 *
 * Drives the full lifecycle against a running Kibana:
 *   1. Write a known-good workflow YAML to a temp dir
 *   2. Validate via /api/workflows/validate
 *   3. Deploy (create) via POST /api/workflows/workflow
 *   4. List + Get to confirm it's there
 *   5. Run via POST /api/workflows/workflow/{id}/run
 *   6. Poll execution status until terminal
 *   7. Fetch logs
 *   8. Delete the test workflow to leave Kibana clean
 *   9. Print a PASS/FAIL summary
 *
 * Exits 0 on success, non-zero on any failure. Designed to be invoked from
 * CI, from a fresh user setup ("does this thing actually work?"), or as a
 * demo so reviewers can see the loop in action.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { kibanaGet, kibanaPost, kibanaDelete, kibanaFetch } from './kibana-client.js';

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

const SAMPLE_YAML = `version: '1'
name: kibana-workflows-smoke
description: End-to-end smoke test for the kibana-workflows skill (auto-deleted after the run).
enabled: true
tags: ["smoke", "poc"]

triggers:
  - type: manual

steps:
  - name: log_hello
    type: console
    with:
      message: "Hello from the kibana-workflows smoke test."
`;

const steps = [];
let testWorkflowId;

function recordStep(name, status, detail) {
  steps.push({ name, status, detail });
  const tag = status === 'ok' ? 'OK' : 'FAIL';
  const banner = status === 'ok' ? '[OK  ]' : '[FAIL]';
  console.log(`${banner} ${name}${detail ? ` — ${detail}` : ''}`);
  if (status !== 'ok') {
    throw new Error(`Step "${name}" failed: ${detail || 'no detail'}`);
  }
  return tag;
}

async function step1WriteYaml() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kibana-workflows-smoke-'));
  const file = path.join(dir, 'smoke.yaml');
  fs.writeFileSync(file, SAMPLE_YAML);
  recordStep('Wrote sample YAML', 'ok', file);
  return file;
}

async function step2Validate(file) {
  const yaml = fs.readFileSync(file, 'utf8');
  const result = await kibanaFetch(`${WORKFLOWS_BASE}/validate`, {
    method: 'POST',
    body: JSON.stringify({ yaml }),
    headers: {
      'elastic-api-version': '1',
      'x-elastic-internal-origin': 'kibana-workflows-smoke',
    },
  });
  if (!result.success || !result.data?.valid) {
    recordStep('Validate YAML', 'fail', result.error || 'validation failed');
  }
  recordStep('Validate YAML', 'ok', 'valid');
  return yaml;
}

async function step3Deploy(yaml) {
  const created = await kibanaPost(WORKFLOW_BASE, { yaml });
  testWorkflowId = created?.id;
  if (!testWorkflowId) {
    recordStep('Deploy workflow', 'fail', 'no ID returned');
  }
  recordStep('Deploy workflow', 'ok', `id=${testWorkflowId}`);
  return testWorkflowId;
}

async function step4ListAndGet(id) {
  const list = await kibanaGet(WORKFLOWS_BASE);
  const ids = (list.results || []).map((w) => w.id);
  if (!ids.includes(id)) {
    recordStep('Workflow appears in list', 'fail', `id ${id} missing`);
  }
  recordStep('Workflow appears in list', 'ok', `${ids.length} total`);

  const fetched = await kibanaGet(`${WORKFLOW_BASE}/${encodeURIComponent(id)}`);
  if (fetched.id !== id) {
    recordStep('Get workflow by id', 'fail', `expected ${id}, got ${fetched.id}`);
  }
  recordStep('Get workflow by id', 'ok', `name="${fetched.name}"`);
}

async function step5Run(id) {
  const result = await kibanaPost(`${WORKFLOW_BASE}/${encodeURIComponent(id)}/run`, {
    inputs: {},
  });
  const executionId = result?.workflowExecutionId;
  if (!executionId) {
    recordStep('Run workflow', 'fail', 'no executionId returned');
  }
  recordStep('Run workflow', 'ok', `executionId=${executionId}`);
  return executionId;
}

async function step6Poll(executionId, { timeoutMs = 30_000, intervalMs = 1_500 } = {}) {
  const started = Date.now();
  let lastStatus;
  while (Date.now() - started < timeoutMs) {
    const data = await kibanaGet(`${EXECUTIONS_BASE}/${encodeURIComponent(executionId)}`);
    if (data.status !== lastStatus) {
      lastStatus = data.status;
    }
    if (TERMINAL_EXECUTION_STATUSES.has(data.status)) {
      const elapsed = Math.round((Date.now() - started) / 1000);
      const ok = data.status === 'completed';
      recordStep('Poll execution', ok ? 'ok' : 'fail', `status=${data.status} after ${elapsed}s`);
      return data;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  recordStep('Poll execution', 'fail', `timed out (last status=${lastStatus || 'unknown'})`);
}

async function step7Logs(executionId) {
  const data = await kibanaGet(`${EXECUTIONS_BASE}/${encodeURIComponent(executionId)}/logs`);
  const entries = data.logs || data.results || [];
  recordStep('Fetch execution logs', 'ok', `${entries.length} entries`);
}

async function step8Cleanup(id) {
  if (!id) return;
  await kibanaDelete(`${WORKFLOW_BASE}/${encodeURIComponent(id)}`);
  recordStep('Delete workflow', 'ok', id);
}

function printSummary() {
  console.log('');
  console.log('Summary:');
  for (const s of steps) {
    const tag = s.status === 'ok' ? 'OK  ' : 'FAIL';
    console.log(`  [${tag}] ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
  }
}

async function main() {
  console.log('kibana-workflows smoke test');
  console.log('============================');
  try {
    const file = await step1WriteYaml();
    const yaml = await step2Validate(file);
    const id = await step3Deploy(yaml);
    await step4ListAndGet(id);
    const executionId = await step5Run(id);
    await step6Poll(executionId);
    await step7Logs(executionId);
    await step8Cleanup(id);
    printSummary();
    console.log('');
    console.log('PASS');
  } catch (error) {
    printSummary();
    console.log('');
    console.error(`FAIL: ${error.message}`);
    if (testWorkflowId) {
      try {
        await step8Cleanup(testWorkflowId);
      } catch (cleanupError) {
        console.error(`Cleanup failed: ${cleanupError.message}`);
      }
    }
    process.exit(1);
  }
}

main();
