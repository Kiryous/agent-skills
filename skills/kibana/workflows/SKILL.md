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

| Variable          | Required | Description                                                                    |
| ----------------- | -------- | ------------------------------------------------------------------------------ |
| `KIBANA_URL`      | Yes      | Kibana base URL (e.g. `http://localhost:5601` or `https://my.kb.elastic-cloud.com`) |
| `KIBANA_API_KEY`  | No       | API key for authentication (preferred)                                         |
| `KIBANA_USERNAME` | No       | Username for basic auth (falls back to `ELASTICSEARCH_USERNAME`)               |
| `KIBANA_PASSWORD` | No       | Password for basic auth (falls back to `ELASTICSEARCH_PASSWORD`)               |
| `KIBANA_SPACE_ID` | No       | Kibana space ID (omit for default space)                                       |
| `KIBANA_INSECURE` | No       | Set to `true` to skip TLS verification (local dev only)                        |

Provide either `KIBANA_API_KEY` or `KIBANA_USERNAME` + `KIBANA_PASSWORD`. The same credentials drive the MCP client when `setup-mcp.js` writes the auth header. With `KIBANA_API_KEY` the script emits a `${env:KIBANA_API_KEY}` substitution so the secret stays in your shell environment; with basic auth it writes the Base64-encoded `username:password` directly into the MCP client config (acceptable for local dev, but prefer an API key elsewhere).

If the script reports a connection error, stop and tell the user to verify their `KIBANA_URL` and authentication environment variables.

## MCP setup

### What gets configured

`setup-mcp.js` configures one MCP server, by default named `elastic-workflows`, pointing at:

```
${KIBANA_URL}/api/agent_builder/mcp?namespace=platform.workflows
```

The `namespace=platform.workflows` filter restricts the MCP surface to workflow authoring tools only — it does not expose every Agent Builder tool.

It uses [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) to bridge the HTTP MCP transport into a stdio MCP client and injects the Kibana auth header from your environment.

### Run setup

```bash
# Detect installed clients automatically and update each one.
node skills/kibana/workflows/scripts/setup-mcp.js

# Target specific clients explicitly.
node skills/kibana/workflows/scripts/setup-mcp.js --client cursor --client claude-code

# Print the MCP server JSON without writing any file.
node skills/kibana/workflows/scripts/setup-mcp.js --dry-run

# Use a custom server name or namespace filter.
node skills/kibana/workflows/scripts/setup-mcp.js --name my-elastic-workflows
node skills/kibana/workflows/scripts/setup-mcp.js --namespace platform.workflows,platform.core
```

Supported clients in the POC: `cursor`, `claude-code`, `claude-desktop`. Reruns are idempotent — the script merges the entry rather than appending duplicates.

### Available MCP tools

After setup, the workflow authoring tools are exposed to your agent under their full `platform.workflows.*` IDs:

**Lookup tools (use these):**
- `platform.workflows.get_step_definitions` — Look up available step types, their `with` params, config params, and examples
- `platform.workflows.get_trigger_definitions` — Look up available trigger types and their event schemas
- `platform.workflows.get_examples` — Search the bundled example library for working workflow YAML patterns
- `platform.workflows.get_connectors` — Find connector instances configured in the user's environment
- `platform.workflows.validate_workflow` — Validate a complete workflow YAML string. When validation fails, step definitions for referenced step types are automatically included in the response.

**Edit tools (DO NOT use over MCP):**

The `platform.workflows.workflow_*` edit tools (`workflow_set_yaml`, `workflow_insert_step`, `workflow_modify_step`, `workflow_modify_step_property`, `workflow_modify_property`, `workflow_delete_step`) are designed for the in-Kibana editor. They mutate a `workflow.yaml` attachment that does not exist outside Kibana. **From an external agent, edit the local YAML file directly with Read / Write / Edit and revalidate via `validate_workflow`.**

If you ever see those tools in your tool list, ignore them and go through the local-file flow described below.

## Authoring Workflow

Use this loop whenever you create or modify a workflow `.yaml` file:

1. **Locate or create the file.** If the user gave you a path, use it. Otherwise default to `${CWD}/workflows/<name>.yaml` and create the parent directory.
2. **Search examples first.** Before writing or modifying steps you have not seen in this conversation, call `platform.workflows.get_examples` for a similar use case. This avoids inventing step shapes.
3. **Verify step type IDs.** Call `platform.workflows.get_step_definitions` to confirm the exact step `type` ID (e.g. `kibana.createCase`, not `kibana`; `http`, not `http.request`). Pass `includeOutputSummary: true` when you need to reference a step's output downstream.
4. **Discover triggers.** For non-`manual` triggers, call `platform.workflows.get_trigger_definitions` to see the event schema (especially for `alert` triggers).
5. **Discover connectors.** When wiring Slack / Jira / PagerDuty / etc., call `platform.workflows.get_connectors` so you reference real `connector-id` values.
6. **Write or edit the local YAML** with your file tools.
7. **Validate.** Call `platform.workflows.validate_workflow` with the full YAML string. If it returns errors, fix them in the file and revalidate.
8. **Deploy / run.** Use `workflow-manager.js` (see below).

Skip steps 2–5 for trivial edits where you already know the correct shape.

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
