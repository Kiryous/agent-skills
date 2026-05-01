# Workflows YAML Reference

Reference material for Elastic Workflow YAML structure, common step patterns, and Liquid templating, lifted from the in-Kibana developer guide so this skill is self-contained.

For the full bundled example library, see [`elastic/workflows`](https://github.com/elastic/workflows). For up-to-date step / trigger / connector definitions, prefer the MCP tools (`platform.workflows.get_step_definitions`, `get_trigger_definitions`, `get_connectors`) — they reflect the live runtime.

## Workflow Categories

The bundled example library is organized by use case:

| Category          | Path                          | Description                              |
| ----------------- | ----------------------------- | ---------------------------------------- |
| Examples          | `workflows/examples/`         | Getting started demos                    |
| Security          | `workflows/security/`         | Detection, response, enrichment          |
| Integrations      | `workflows/integrations/`     | Splunk, Slack, Jenkins, JIRA, etc.       |
| Search            | `workflows/search/`           | ES\|QL, semantic search                  |
| AI Agents         | `workflows/ai-agents/`        | AI-powered automation                    |
| Data              | `workflows/data/`             | ETL and data management                  |
| Utilities         | `workflows/utilities/`        | Common utility workflows                 |
| Observability     | `workflows/observability/`    | Monitoring and analysis                  |

## Workflow Structure

```yaml
name: "Workflow Name"              # required
description: "What it does"        # optional
tags: ["category", "type"]         # optional

triggers:                          # optional (defaults to manual)
  - type: manual | scheduled | alert

consts:                            # optional — workflow constants
  api_key: "value"

inputs:                            # optional — runtime parameters
  - name: param_name
    type: string
    required: true

steps:                             # required — at least one step
  - name: "step_name"
    type: "action.type"
    with:
      param: value
```

## Common Patterns

When the user asks about a specific pattern, search the bundled example library with `platform.workflows.get_examples` for the closest match. Some standing references:

### Basic workflow structure
- `workflows/examples/national-parks-demo.yaml`
  - Complete workflow structure
  - Index operations, search, foreach loops
  - Well-commented for learning

### HTTP API integration
- `workflows/security/enrichment/ip-reputation-check.yaml`
  - Making HTTP requests
  - Error handling with retries
  - Processing API responses

### Elasticsearch operations
- `workflows/search/semantic-knowledge-search.yaml`
  - ES\|QL queries
  - Search operations
  - Working with results

### Foreach loops
- `workflows/security/enrichment/rootcausefromdiscover.yaml`
  - Iterating over arrays
  - Accessing loop context (`foreach.item`)
  - Nested step execution

### Conditional logic
- `workflows/security/detection/hash-threat-check.yaml`
  - Using `type: if` steps
  - Condition expressions
  - Branching logic

### Scheduled triggers
- Any workflow with a scheduled trigger
  - Simple interval format (`every: "6h"`)
  - Recurrence rules (rrule)

### Integration examples
- Slack: `workflows/integrations/slack/`
- Splunk: `workflows/integrations/splunk/`
- JIRA: `workflows/integrations/jira/`
- Jenkins: `workflows/integrations/jenkins/`

## Liquid Templating Quick Reference

Workflows use Liquid templating extensively.

### Variable Syntax

```yaml
{{ consts.api_key }}              # Constants
{{ inputs.target_ip }}            # Runtime inputs
{{ steps.search.output.hits }}    # Step outputs
{{ foreach.item._id }}            # Loop context
{{ event }}                       # Trigger event data (NEVER triggers.event)
```

### Common Filters

```yaml
{{ text | upcase }}               # String manipulation
{{ items | size }}                # Array length
{{ data | json }}                 # Convert to JSON
{{ value | default: "fallback" }} # Default values
{{ array | map: "name" }}         # Extract property
{{ items | where: "status", "active" }} # Filter array
```

### Control Flow

```yaml
{%- if condition -%}
  content
{%- elsif other -%}
  other content
{%- else -%}
  fallback
{%- endif -%}

{%- for item in items -%}
  {{ item.name }}
{%- endfor -%}
```

## Notes

- The workflows library is comprehensive — use it as the source of truth.
- Always verify syntax against actual examples, not assumptions.
- Liquid templating reference: <https://liquidjs.com/filters/overview.html>
- Examples are well-commented; read them to understand patterns.
- When unsure, fetch step / trigger / connector schemas via the MCP lookup tools before writing YAML.
