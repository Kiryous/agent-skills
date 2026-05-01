---
name: kibana-workflows
description: >
  Author, validate, and deploy Elastic Workflow YAML definitions from outside Kibana.
  Use when the user wants to create or modify a `.yaml` workflow locally and validate or run it
  against an Elastic / Kibana instance over MCP. Covers step types, triggers, Liquid templating,
  connector integrations, and the validate / deploy / run lifecycle.
metadata:
  author: elastic
  version: 0.1.0
disable-model-invocation: true
allowed-tools: Bash(node *), Read, Write, Edit, Glob, Grep
argument-hint: '[workflow-file]'
---

# Author and Manage Elastic Workflows from Outside Kibana

Create, modify, validate, deploy, and run Elastic Workflow YAML definitions from any agent surface (Cursor, Claude Code, Claude Desktop, etc.) using a local `.yaml` file plus Kibana's Agent Builder MCP server.

If the user provided a path, treat **$ARGUMENTS** as the default workflow file.

## Try it in 60 seconds

Once a Kibana with the Agent Builder MCP endpoint is running, this entire loop should succeed unattended:

```bash
# 1. Install the skill from a local agent-skills checkout (or from GitHub).
gh skill install /path/to/agent-skills kibana-workflows --from-local --agent cursor --scope user

# 2. Wire your MCP client to Kibana (writes ~/.cursor/mcp.json or equivalent).
export KIBANA_URL=https://my.kb.elastic-cloud.com
export KIBANA_API_KEY=...   # or KIBANA_USERNAME + KIBANA_PASSWORD
node skills/kibana/workflows/scripts/setup-mcp.js

# 3. Confirm the full lifecycle works end-to-end against your Kibana.
node skills/kibana/workflows/scripts/smoke.js
```

`smoke.js` writes a sample YAML, validates it, deploys it, runs it, polls execution status until terminal, fetches logs, and deletes the workflow. It exits non-zero on any failure with the offending step and reason — use it as a sanity check before reaching for the agent.

## How This Skill Works

Workflow authoring inside Kibana uses the in-product workflow editor and a set of Agent Builder tools. From outside Kibana the architecture is split into two halves:

1. **Lookup, discovery, and validation** are handled by Kibana's Agent Builder MCP server — the same code path the in-Kibana editor uses. You call those tools over MCP.
2. **Editing** is just local file I/O: read the local `.yaml`, modify it with your normal Read / Write / Edit tools, and re-run validation over MCP. There are no `workflow.yaml` attachments and no diff/accept UX outside Kibana.

This means you do not need to reimplement validation, step discovery, or example search — they live in Kibana and are reused as-is.

## Prerequisites

### 1. Kibana with Agent Builder MCP enabled

You need a Kibana that exposes `/api/agent_builder/mcp` (Agent Builder MCP server, available since 9.2). Local development (`yarn start`) and Cloud / Serverless deployments both work. An Enterprise (or trial) license is required — Agent Builder APIs return `403` on Basic.

The workflow authoring tools are gated by an Advanced Setting and are not exposed by default. Enable them once per space:

```bash
curl -u "$KIBANA_USERNAME:$KIBANA_PASSWORD" -X POST \
  "$KIBANA_URL/internal/kibana/settings/agentBuilder:experimentalFeatures" \
  -H "Content-Type: application/json" \
  -H "kbn-xsrf: true" \
  -H "x-elastic-internal-origin: kibana" \
  -d '{"value": true}'
```

You can also flip this from **Stack Management → Advanced Settings → `agentBuilder:experimentalFeatures`**. Without it, `/api/agent_builder/tools` will not list any `platform.workflows.*` tools and they will not appear over MCP either.

### 2. MCP client configured

Set up your agent's MCP client to point at Kibana's MCP endpoint, filtered to the workflow tools namespace:

```bash
node skills/kibana/workflows/scripts/setup-mcp.js
```

This writes (or merges) an `elastic-workflows` MCP server entry into your client config. See the **MCP setup** section below for details and flags.

### 3. Environment variables

Set these before running any of the bundled scripts:

| Variable                | Required | Description                                                                                  |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `KIBANA_URL`            | Yes      | Kibana base URL (e.g. `http://localhost:5601` or `https://my.kb.elastic-cloud.com`)          |
| `KIBANA_API_KEY`        | No       | Preferred. Explicit Kibana API key for the auth header.                                      |
| `ELASTICSEARCH_API_KEY` | No       | Cloud Management skill handoff (see "Bootstrap from cloud-manage-project" below).            |
| `KIBANA_USERNAME`       | No       | Username for basic auth (falls back to `ELASTICSEARCH_USERNAME`)                             |
| `KIBANA_PASSWORD`       | No       | Password for basic auth (falls back to `ELASTICSEARCH_PASSWORD`)                             |
| `KIBANA_SPACE_ID`       | No       | Kibana space ID (omit for default space)                                                     |
| `KIBANA_INSECURE`       | No       | Set to `true` to skip TLS verification (local dev only)                                      |

Auth precedence: `KIBANA_API_KEY` → `ELASTICSEARCH_API_KEY` → `KIBANA_USERNAME` + `KIBANA_PASSWORD`. The same credentials drive both the bundled scripts and the MCP client that `setup-mcp.js` writes. With either API-key form the script emits a `${env:VAR_NAME}` substitution so the secret stays in your shell environment; with basic auth it writes the Base64-encoded `username:password` directly into the MCP client config (acceptable for local dev, but prefer an API key elsewhere).

If the script reports a connection error, stop and tell the user to verify their `KIBANA_URL` and authentication environment variables.

#### Bootstrap from `cloud-manage-project` (Elastic Cloud Serverless)

If the user is on Elastic Cloud Serverless and has the [`cloud-manage-project`](https://github.com/elastic/agent-skills/tree/main/skills/cloud/manage-project) skill installed, they do **not** need to manually export `KIBANA_URL` or `KIBANA_API_KEY`. The cloud skill's `load-credentials` helper exports both `KIBANA_URL` and `ELASTICSEARCH_API_KEY` in one shot:

```bash
# (one-off, if a project doesn't exist yet)
python3 .../skills/cloud/create-project/scripts/create-project.py create \
  --type elasticsearch --name my-workflow-poc --region gcp-us-central1 \
  --optimized-for general_purpose --wait

# every session — exports KIBANA_URL + ELASTICSEARCH_API_KEY for this shell
eval $(python3 .../skills/cloud/manage-project/scripts/manage-project.py \
  load-credentials --name my-workflow-poc)

# now setup-mcp.js / smoke.js / workflow-manager.js work without further env vars
node skills/kibana/workflows/scripts/setup-mcp.js
```

Caveats when using this path:

- **The API key needs `agentBuilder:read`** to call `/api/agent_builder/mcp`, plus `workflowsManagement` privileges for the workflow REST routes used by `workflow-manager.js`. Create the scoped key via the [`elasticsearch-authn`](https://github.com/elastic/agent-skills/tree/main/skills/elasticsearch/elasticsearch-authn) skill or in **Kibana → Stack Management → API keys**, then save it to `.elastic-credentials` so `load-credentials` picks it up.
- **MCP clients see the env at launch time.** Cursor / Claude Desktop / Claude Code inherit the shell environment they were started in. Run `eval $(... load-credentials ...)` in the shell *before* launching (or restarting) the MCP client, otherwise `${env:ELASTICSEARCH_API_KEY}` will be empty and the MCP server will get `401`.
- **Self-managed and local-dev Kibanas don't need any of this** — `KIBANA_API_KEY` (or `KIBANA_USERNAME` + `KIBANA_PASSWORD`) work the same as before.

## MCP setup

### What gets configured

`setup-mcp.js` configures one MCP server, by default named `elastic-workflows`, pointing at:

```
${KIBANA_URL}/api/agent_builder/mcp?namespace=platform.workflows,platform.core
```

The `namespace` filter restricts the MCP surface to a curated set of namespaces so the agent does not get drowned in 50+ unrelated tools. The default exposes:

- `platform.workflows.*` — workflow authoring + lifecycle (`validate_workflow`, `get_step_definitions`, `get_examples`, `deploy_workflow`, `run_workflow`, …)
- `platform.core.*` — execution inspection + general-purpose Elastic tools (`get_workflow_execution_status`, `resume_workflow_execution`, `get_index_mapping`, `list_indices`, `generate_esql`, `execute_esql`, `cases`, `product_documentation`, …)

It uses [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) to bridge the HTTP MCP transport into a stdio MCP client and injects the Kibana auth header from your environment.

### Run setup

```bash
# Detect installed clients automatically and update each one.
node skills/kibana/workflows/scripts/setup-mcp.js

# Target specific clients explicitly.
node skills/kibana/workflows/scripts/setup-mcp.js --client cursor --client claude-code

# Print the MCP server JSON without writing any file.
node skills/kibana/workflows/scripts/setup-mcp.js --dry-run

# Narrow or broaden the exposed tool surface.
node skills/kibana/workflows/scripts/setup-mcp.js --namespace platform.workflows
node skills/kibana/workflows/scripts/setup-mcp.js --namespace platform.workflows,platform.core,platform.streams

# Use a custom server name (handy if you also have a generic Elastic MCP entry).
node skills/kibana/workflows/scripts/setup-mcp.js --name my-elastic-workflows
```

Supported clients in the POC: `cursor`, `claude-code`, `claude-desktop`. Reruns are idempotent — the script merges the entry rather than appending duplicates.

### Available MCP tools

After setup, the agent has access to two groups of tools.

**Authoring + lifecycle (`platform.workflows.*`):**

| Tool | Purpose |
| --- | --- |
| `get_step_definitions` | Look up available step types, their `with` params, config params, and examples. |
| `get_trigger_definitions` | Look up available trigger types and their event schemas. |
| `get_examples` | Search the bundled example library for working YAML patterns. |
| `get_connectors` | Find connector instances configured in the user's environment. |
| `validate_workflow` | Validate a complete workflow YAML string. When validation fails, step definitions for referenced step types are automatically included in the response. |
| `deploy_workflow` | Create or update a workflow from YAML. Pass `id` to update in place; omit to create. |
| `run_workflow` | Execute a deployed workflow (by `workflowId`) or an unsaved draft (by inline `yaml`). Returns a `workflowExecutionId`. |

**Execution inspection + general-purpose (`platform.core.*`):**

| Tool | Purpose |
| --- | --- |
| `get_workflow_execution_status` | Status (and final output, when complete) for a `workflowExecutionId`. |
| `resume_workflow_execution` | Resume an execution that is `waiting_for_input`. |
| `get_index_mapping` | Index mapping for one or more Elasticsearch indices. |
| `list_indices` / `index_explorer` | Discover what indices exist in the cluster. |
| `generate_esql` / `execute_esql` | Author and run ES\|QL queries against the cluster. |
| `cases` | Read / write Kibana Cases. |
| `product_documentation` | Search Elastic documentation for relevant guidance. |

**In-Kibana edit tools — not exposed by default.**

The `platform.workflows.workflow_*` edit tools (`workflow_set_yaml`, `workflow_insert_step`, `workflow_modify_step`, `workflow_modify_step_property`, `workflow_modify_property`, `workflow_delete_step`) are designed for the in-Kibana editor — they mutate a `workflow.yaml` attachment that does not exist outside Kibana. They are gated behind the `agentBuilder:experimentalFeatures` advanced setting and, even when surfaced, should not be used from an external agent. **From outside Kibana, edit the local YAML file directly with Read / Write / Edit and revalidate via `validate_workflow`.**

## Authoring Workflow

Use this loop whenever you create or modify a workflow `.yaml` file:

1. **Locate or create the file.** If the user gave you a path, use it. Otherwise default to `${CWD}/workflows/<name>.yaml` and create the parent directory.
2. **Search examples first.** Before writing or modifying steps you have not seen in this conversation, call `platform.workflows.get_examples` for a similar use case. This avoids inventing step shapes.
3. **Verify step type IDs.** Call `platform.workflows.get_step_definitions` to confirm the exact step `type` ID (e.g. `kibana.createCase`, not `kibana`; `http`, not `http.request`). Pass `includeOutputSummary: true` when you need to reference a step's output downstream.
4. **Discover triggers.** For non-`manual` triggers, call `platform.workflows.get_trigger_definitions` to see the event schema (especially for `alert` triggers).
5. **Discover connectors.** When wiring Slack / Jira / PagerDuty / etc., call `platform.workflows.get_connectors` so you reference real `connector-id` values.
6. **Write or edit the local YAML** with your file tools.
7. **Validate.** Call `platform.workflows.validate_workflow` with the full YAML string. If it returns errors, fix them in the file and revalidate.
8. **Deploy.** Call `platform.workflows.deploy_workflow` with the YAML (and `id` for an in-place update). Falls back to `workflow-manager.js deploy` if you need a non-MCP path.
9. **Run.** Call `platform.workflows.run_workflow` to execute the deployed workflow (or an unsaved YAML draft). Capture the returned `workflowExecutionId`.
10. **Inspect.** Call `platform.core.get_workflow_execution_status` with the `workflowExecutionId` to track progress; for richer diagnostics use `workflow-manager.js logs --execution-id <id>`.

Skip steps 2–5 for trivial edits where you already know the correct shape. Prefer the MCP tools over the script when both are available — they keep the agent in a single tool-calling loop instead of shelling out.

## Workflow Manager Lifecycle

`workflow-manager.js` is a thin CLI over Kibana's public workflow REST API. Use it for deploy, list, run, and inspect — anything beyond authoring and validation.

### List workflows

```bash
node skills/kibana/workflows/scripts/workflow-manager.js list
node skills/kibana/workflows/scripts/workflow-manager.js list --query "alert"
```

### Get a single workflow

```bash
node skills/kibana/workflows/scripts/workflow-manager.js get --id "<workflow_id>"
```

### Validate a local YAML against Kibana

```bash
node skills/kibana/workflows/scripts/workflow-manager.js validate --file ./workflows/my-workflow.yaml
```

This calls `POST /api/workflows/validate` and prints the full diagnostic list. Prefer the MCP `validate_workflow` tool from the agent's perspective — `workflow-manager.js validate` exists as a fallback and a CI-friendly entry point.

### Deploy (create or update from a local file)

```bash
# Create a new workflow from a local YAML file.
node skills/kibana/workflows/scripts/workflow-manager.js deploy --file ./workflows/my-workflow.yaml

# Update an existing workflow in place.
node skills/kibana/workflows/scripts/workflow-manager.js deploy --file ./workflows/my-workflow.yaml --id "<workflow_id>"
```

`deploy` POSTs to `/api/workflows/workflow` for new workflows, or PUTs to `/api/workflows/workflow/{id}` for existing ones. The script prints the resulting workflow ID.

### Run a deployed workflow

```bash
node skills/kibana/workflows/scripts/workflow-manager.js run \
  --id "<workflow_id>" \
  --inputs '{"target_ip": "1.2.3.4"}'
```

This calls `POST /api/workflows/workflow/{id}/run` and prints the resulting `workflowExecutionId`. The workflow must be enabled and valid.

### Test a local YAML without saving

```bash
node skills/kibana/workflows/scripts/workflow-manager.js test \
  --file ./workflows/my-workflow.yaml \
  --inputs '{"target_ip": "1.2.3.4"}'
```

This calls `POST /api/workflows/test` so you can run an unsaved draft.

### Delete a workflow

```bash
node skills/kibana/workflows/scripts/workflow-manager.js delete --id "<workflow_id>"
```

Always confirm with the user before deleting. Deletion is permanent.

### Inspect executions

After `run` or `test` returns a `workflowExecutionId`, use these to follow the run. The MCP `platform.core.get_workflow_execution_status` tool covers the same ground from the agent's side; these commands are the CI / Bash-friendly equivalents.

```bash
# List executions for a workflow.
node skills/kibana/workflows/scripts/workflow-manager.js executions \
  --workflow-id "<workflow_id>" \
  --statuses running,completed --size 20

# Get a single execution's details (optionally include input / output payloads).
node skills/kibana/workflows/scripts/workflow-manager.js execution \
  --id "<execution_id>" --include-input --include-output

# Block until the execution reaches a terminal state (or timeout).
node skills/kibana/workflows/scripts/workflow-manager.js poll \
  --id "<execution_id>" --timeout 60 --interval 2

# Fetch paginated logs (optionally filter to a single step execution).
node skills/kibana/workflows/scripts/workflow-manager.js logs \
  --execution-id "<execution_id>"
```

### End-to-end demo

The full happy-path loop, from agent + skill perspective, is:

1. `platform.workflows.get_examples` — pull a relevant example
2. `platform.workflows.get_step_definitions` — confirm step IDs
3. Edit `./workflows/<name>.yaml` locally
4. `platform.workflows.validate_workflow` — fix any diagnostics
5. `platform.workflows.deploy_workflow` (or `workflow-manager.js deploy`) — capture the workflow ID
6. `platform.workflows.run_workflow` (or `workflow-manager.js run`) — capture the `workflowExecutionId`
7. `platform.core.get_workflow_execution_status` (or `workflow-manager.js poll --id <execution_id>`) — wait for terminal status
8. `workflow-manager.js logs --execution-id <id>` — surface logs to the user if anything looks off

## Workflow YAML Structure

A workflow YAML file has this structure:

```yaml
version: '1'
name: Workflow Name
description: Description of what the workflow does
enabled: true
tags: ["tag1", "tag2"]

consts:
  my_constant: "value"

inputs:
  properties:
    input_name:
      type: string
      description: Input description
      default: "default value"

triggers:
  - type: manual
  # or:
  # - type: scheduled
  #   with:
  #     every: "5m"
  # or: type: alert

steps:
  - name: step_name
    type: step_type
    with:
      param1: value1
      param2: "{{ liquid_expression }}"
```

### Common Step Properties

Every step (regardless of type) supports these properties. They are NOT repeated per step in tool results.

```yaml
- name: unique_step_name       # required, unique within the workflow
  type: step_type              # required, the step type ID
  with:                        # input parameters (specific to step type)
    param1: value1
  connector-id: my-connector   # only for connector-based steps that require it
  if: "steps.prev.output.ok"   # optional, skip step when condition is falsy
  timeout: "30s"               # optional, step-level timeout
  on-failure:                  # optional, error handling
    retry:
      max-attempts: 3
      delay: "5s"
    fallback:                  # fallback steps on failure
      - name: handle_error
        type: console
        with:
          message: "Step failed"
    continue: true             # optionally continue execution after failure
```

- **`with`**: the step's input parameters (listed as `inputParams` in tool results)
- **Config params**: step-level fields outside `with` (listed as `configParams` in tool results, e.g. `condition` / `steps` / `else` for `if`, `foreach` / `steps` for `foreach`)
- **`connector-id`**: required or optional depending on step type (shown in tool results)

### Step Types

#### Built-in Step Types

- **http** — Make HTTP requests to external APIs
- **foreach** — Loop over collections with nested steps
- **if** — Conditional execution with `condition` and optional `else` block
- **data.set** — Set variables in workflow context
- **data.transform** — Transform data using expressions
- **wait** — Pause execution for a duration
- **console** — Log messages to execution output
- **elasticsearch.search** — Query Elasticsearch indices
- **elasticsearch.bulk** — Bulk index documents
- **ai.agent** — Invoke an AI agent

#### Connector-Based Step Types (PREFERRED for integrations)

Workflows can use Kibana connectors for integrations. These use the connector name as the step type and require a `connector-id` to specify which configured connector to use.

**ALWAYS prefer connector steps over raw HTTP for integrations like Slack, Jira, PagerDuty, ServiceNow, etc.** Connector steps are simpler, more secure, and handle authentication automatically.

**Slack connector example (PREFERRED):**

```yaml
- name: send_slack_notification
  type: slack
  connector-id: my-slack-connector
  with:
    message: "Hello from the workflow!"
```

When asked to add a Slack/Jira/etc integration, ALWAYS use connector steps first, and call `platform.workflows.get_connectors` to find the `connector-id` values configured in the user's environment.

### Verify Step Type IDs Before Editing

**ALWAYS call `platform.workflows.get_step_definitions` to verify the exact step type ID before inserting a new step or changing a step's type.** Step types have specific IDs (e.g. `kibana.createCase`, not `kibana`; `http`, not `http.request`). Using an incorrect type ID will produce a validation error — verify the ID first to avoid invalid YAML.

Deprecated step types are excluded from discovery by default; if you are maintaining an existing workflow that already uses one, call `get_step_definitions` with `stepType` set to the exact legacy ID or pass `includeDeprecated: true`.

### Liquid Templating

Use Liquid syntax for dynamic values:

- `{{ steps.step_name.output.field }}` — Reference step outputs (ONLY `output` is accessible — NEVER `steps.<name>.with.*` or `steps.<name>.<input_param>`). Use `platform.workflows.get_step_definitions` with `includeOutputSummary` to learn what a step's output contains.
- `{{ inputs.input_name }}` — Reference workflow inputs
- `{{ consts.constant_name }}` — Reference constants
- `{{ foreach.item }}` — Current item in a foreach loop
- `{{ event }}` — Trigger event data (available for all trigger types)

**IMPORTANT — event variable path:** The trigger event is accessed via `{{ event }}` directly — NEVER `{{ triggers.event }}`, `{{ trigger.event }}`, or `{{ triggers.event.* }}`. The `triggers` block only configures which triggers activate the workflow; it does NOT contain runtime event data.

**Alert trigger event structure** (available when `triggers` includes `type: alert`):

- `{{ event.alerts }}` — Array of alert objects that fired
- `{{ event.alerts[0]._id }}` — Alert ID
- `{{ event.alerts[0]._index }}` — Alert index
- `{{ event.alerts[0].kibana.alert }}` — Alert details
- `{{ event.alerts[0]["@timestamp"] }}` — Alert timestamp
- `{{ event.rule.id }}` — Rule ID
- `{{ event.rule.name }}` — Rule name
- `{{ event.rule.tags }}` — Rule tags
- `{{ event.spaceId }}` — Space where the event was emitted

Use `platform.workflows.get_trigger_definitions` to get the full event context schema for any trigger type.

Useful filters:

- `| json` — Convert to JSON string
- `| url_encode` — URL encode a string
- `| default: "value"` — Provide default if nil

### Self-Validation Before Deploying

When you generate or modify workflow YAML, you SHOULD validate it before deploying:

1. Write the YAML to disk
2. Call `platform.workflows.validate_workflow` with the complete workflow YAML string
3. If validation returns errors: fix the file and re-validate until valid
4. If validation passes: deploy via `workflow-manager.js deploy`

Skip validation for trivial changes where the risk of errors is low.

### Fixing Validation Errors

When fixing validation errors:

1. Call `platform.workflows.validate_workflow` — it automatically includes step definitions for all referenced step types when validation fails
2. Analyze the errors and identify the problematic steps
3. If a step type does NOT exist: tell the user and list similar alternatives from the included step definitions
4. Edit the local YAML and revalidate to confirm the fix
5. NEVER guess or replace a step type with something unrelated
6. **After fixing an error, scan the entire YAML for other occurrences of the same mistake.** For example, if you fix `triggers.event` → `event` in one place, check all other Liquid expressions for the same incorrect pattern and fix them all in one pass

## Examples

### Create a new workflow from scratch

```text
User: /kibana-workflows ./workflows/notify-on-alert.yaml
```

1. Search examples — `get_examples` with `query: "alert notification"`
2. Verify step types — `get_step_definitions` for `slack`
3. Discover connectors — `get_connectors` to find Slack connector IDs
4. Write `./workflows/notify-on-alert.yaml` with the planned YAML
5. Validate — `validate_workflow` with the full YAML
6. Fix any errors and revalidate
7. Deploy — `workflow-manager.js deploy --file ./workflows/notify-on-alert.yaml`
8. Verify — `workflow-manager.js list` to confirm the new entry

### Modify an existing workflow

```text
User: Add a console log step at the start of workflows/notify-on-alert.yaml
```

1. Read the local file
2. Verify step types — `get_step_definitions` for `console` if you have not already in this conversation
3. Edit the file in place to add the step
4. Validate — `validate_workflow`
5. Deploy — `workflow-manager.js deploy --file ./workflows/notify-on-alert.yaml --id "<existing_workflow_id>"`

### Run a deployed workflow

```text
User: Run the notify-on-alert workflow with target IP 1.2.3.4
```

1. Run — `workflow-manager.js run --id "notify-on-alert" --inputs '{"target_ip": "1.2.3.4"}'`
2. Display the returned `workflowExecutionId`

## References

For detailed YAML structure, examples, and Liquid templating reference, see [`references/workflow-yaml-reference.md`](references/workflow-yaml-reference.md). The bundled example library lives at [`elastic/workflows`](https://github.com/elastic/workflows) on GitHub.

## Best Practices

1. Always search examples first before writing step YAML you have not seen in this conversation
2. Use unique step names within the workflow
3. Use 2 spaces per indentation level
4. Use `on-failure` with `retry`, `fallback`, and (optionally) `continue` for error handling
5. Prefer connector steps over raw HTTP for integrations
6. Validate before deploying; do NOT skip validation just because the change is large
7. Confirm with the user before running `delete` — deletion is permanent
8. For non-default Kibana spaces, set `KIBANA_SPACE_ID` before running scripts

## Common errors

If something looks broken end-to-end, walk through these in order — they cover ~90% of POC failures.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `tools/list` returns 0 `platform.workflows.*` tools | `agentBuilder:experimentalFeatures` advanced setting is off | Enable it via the `curl` snippet under "Prerequisites → 1. Kibana with Agent Builder MCP enabled", or in **Stack Management → Advanced Settings** |
| `/api/agent_builder/mcp` returns `403` | Kibana is on Basic license | Run `POST /_license/start_trial?acknowledge=true` against Elasticsearch (one-off) |
| `KIBANA_URL is not set` from `setup-mcp.js` or `workflow-manager.js` | Env vars missing in the shell where you ran the script | `export KIBANA_URL=...` and `KIBANA_API_KEY` (or `KIBANA_USERNAME` + `KIBANA_PASSWORD`); rerun. On Cloud Serverless run `eval $(... cloud/manage-project/scripts/manage-project.py load-credentials --name <project>)` instead — that sets both `KIBANA_URL` and `ELASTICSEARCH_API_KEY` in one go. |
| MCP `tools/list` returns `401 Unauthorized` after a `cloud-manage-project` handoff | The scoped API key in `.elastic-credentials` is missing `agentBuilder:read` (and/or `workflowsManagement` for the REST routes) | Recreate the scoped API key with both privileges (via `elasticsearch-authn` or **Stack Management → API keys**), update `.elastic-credentials`, re-`eval` `load-credentials`, and restart the MCP client |
| `${env:ELASTICSEARCH_API_KEY}` resolves to empty in the MCP request and Kibana returns `401` | Cursor/Claude Code was launched before `eval $(... load-credentials ...)` ran in the shell | Run `eval` in the shell first, then quit and relaunch the MCP client so it inherits the new env |
| `validate_workflow` returns "Invalid step type" diagnostics | Step type ID does not exist on this Kibana | Call `get_step_definitions` to discover valid IDs; never guess |
| `get_connectors` returns nothing for a Slack/Jira step | No connector instance configured in the user's environment | Tell the user to create one in **Stack Management → Connectors** before referencing `connector-id` |
| `run_workflow` returns `"workflow_disabled"` | Workflow saved with `enabled: false` | Set `enabled: true` in the YAML and redeploy |
| `run_workflow` returns `"workflow_invalid"` | Saved YAML failed validation | Re-validate locally, fix, redeploy |
| MCP client never picks up the new server | Client not restarted after `setup-mcp.js` | Quit and relaunch Cursor / Claude Code / Claude Desktop |
| `mcp-remote` shows `Method not found` errors | The MCP session was not initialized — usually a transient transport issue | Restart the MCP client; the wrapper handles `initialize` automatically on reconnect |
