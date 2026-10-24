/**
 * The skills served over MCP (`/mcp`) with the Skills extension (`io.modelcontextprotocol/skills`):
 * workflows that combine the workspace tools (`ASSISTANT_TOOLS`), as Agent Skills. Each is one
 * `SKILL.md` whose frontmatter names the lowest role that can follow it; a person is offered only
 * the skills their role allows, as with tools. Tests check every tool a skill names exists and
 * that the role covers it.
 */

import { atLeast, type Role } from './roles';

export type McpSkill = {
  /** The lowest role that can follow the skill: the strictest of the tools it uses. */
  role: Role;
  /** Paths under the skill's folder, `SKILL.md` first. */
  files: Record<string, string>;
};

export const MCP_SKILLS: Record<string, McpSkill> = {
  'triage-attention': {
    role: 'viewer',
    files: {
      'SKILL.md': `---
name: triage-attention
description: Work out what in OrderLoop needs a person now (open approvals, failed orders, stalled orders) and report it in order of urgency. Use when asked what needs attention, what is stuck, or for a daily check.
metadata:
  role: viewer
---

# Triage what needs attention

1. Call \`needs_attention\`. It returns open approvals (oldest first), orders that failed or rolled
   back in the last 3 days, and orders waiting on a business event for more than a day. The lists
   are capped; \`counts\` are not, so say when there are more than you show.
2. For each approval and failure worth explaining, call \`get_order\` with its id. Read \`status\`,
   \`waits\` (for an approval, \`onApprove\` and \`onReject\` say where each decision leads), the
   \`steps\` with errors, and \`recent\`.
3. When a question needs judgment (is this order unusual, what should happen next), call
   \`assess_order\` with typed questions instead of guessing.
4. Report approvals first (amount, how long they have waited, where each decision leads), then
   failures (which step failed and why), then stalled orders (the event each one waits for). Name
   orders by their #reference and give each one's \`href\`.

Triage changes nothing. Leave decisions, cancellations and events to the person.
`,
    },
  },
  'review-approval': {
    role: 'approver',
    files: {
      'SKILL.md': `---
name: review-approval
description: Review an approval an OrderLoop order is waiting on and, once the person decides, approve or reject it. Use when asked to look at, approve or reject an approval.
metadata:
  role: approver
---

# Review an approval

1. Call \`get_order\` with the order id or #reference. Find the wait whose \`kind\` is \`approval\`:
   note its \`nodeId\` if more than one is open, the \`amount\`, and \`onApprove\` and \`onReject\`.
2. Gather what the approver needs: the customer, total, lines and the steps so far. When it helps,
   call \`assess_order\`, for example a \`noul\` question "Is anything about this order unusual?"
   or a \`choice\` between approving, holding and rejecting with criteria for each.
3. Present what is being approved, the amount, what each decision leads to and anything unusual.
   You may recommend; the person decides.
4. Only once the person has said which decision, call \`decide_approval\` with \`orderId\`,
   \`decision\` (\`approved\` or \`rejected\`), \`nodeId\` when more than one is open, and a \`note\`
   with their reason. The first call changes nothing: the client asks the person to confirm, or
   the call returns a preview and a confirmation code. Send the code back only after the person
   agrees to that preview.

A refusal is for the person to read. If they started the order and the workspace separates
approvals, someone else must decide. If it was already decided, read the order again.
`,
    },
  },
  'change-a-flow': {
    role: 'operator',
    files: {
      'SKILL.md': `---
name: change-a-flow
description: Change how an OrderLoop flow handles orders by reading the flow, drafting a change from an instruction, having the person apply it in the flow editor, then publishing. Use when asked to add, remove or rewire steps in a flow.
metadata:
  role: operator
---

# Change a flow

1. Call \`list_flows\` to find the flow's id if you don't have it, then \`get_flow\` to read its
   steps, connections and validation problems.
2. Call \`propose_flow_change\` with the \`flowId\` and a precise instruction. Nothing is saved.
   Report the \`explanation\`, the counted \`changes\`, and any errors or warnings. If there are
   errors, sharpen the instruction and propose again.
3. Ask the person to open the flow (its \`href\`), review the proposal in the editor and save it
   there. You can't save a draft.
4. Once they have saved it and want it live, call \`publish_flow\` with the \`flowId\`. It
   publishes the saved draft as a new version. The first call changes nothing: the client asks the
   person to confirm, or the call returns a preview and a confirmation code to send back only
   after the person agrees.
`,
    },
  },
  'stock-review': {
    role: 'operator',
    files: {
      'SKILL.md': `---
name: stock-review
description: Check OrderLoop stock against reorder points and, if the person agrees, run the stock review that starts reorders. Use when asked about low stock or to reorder.
metadata:
  role: operator
---

# Stock review

1. Call \`find_products\` with \`belowReorder: true\`. Report each SKU's \`available\` quantity
   (stock less reserved), its \`reorderPoint\` and its supplier.
2. If nothing is at or below its reorder point, say so and stop.
3. If the person wants to reorder now, call \`run_stock_review\`. It runs the daily stock review
   at once and starts reorders for every SKU at or below its reorder point, not a selection of
   them. The first call changes nothing: the client asks the person to confirm, or the call
   returns a preview and a confirmation code to send back only after the person agrees.
4. The reorders show under Commerce (\`/commerce\`).
`,
    },
  },
};

/** The skills a role can follow, as `<skill>/<path>` → contents. */
export function mcpSkillFiles(role: Role): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [name, skill] of Object.entries(MCP_SKILLS)) {
    if (!atLeast(role, skill.role)) continue;
    for (const [path, text] of Object.entries(skill.files)) files[`${name}/${path}`] = text;
  }
  return files;
}
