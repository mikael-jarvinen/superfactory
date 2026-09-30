// Jira, through the claude.ai Atlassian connector. Its tools are deferred, so a session finds the
// search with ToolSearch before calling it. Everything particular to a team is in [tracker]: the
// site and the query that defines the queue.
import type { Workspace } from "../workspace.js";
import { die } from "../util.js";
import { CONTRACT, type Tracker } from "./read.js";

const SEARCH = "mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql";
const GET = "mcp__claude_ai_Atlassian__getJiraIssue";

export const jira: Tracker = {
  kind: "jira",
  reads: true,
  tools: [SEARCH, GET],
  instructions(ws: Workspace): string {
    const { site, queueJql } = ws.config.tracker;
    if (!site) die("tracker.site is not set, and a watcher needs it to reach Jira");
    if (!queueJql) die("tracker.queue_jql is not set, and a watcher needs it to read the queue");
    return `Read the queue from Jira. The Jira tool is deferred: first call ToolSearch with the query
select:${SEARCH}
then call ${SEARCH} with cloudId ${site}, fields summary, and this jql, exactly as written:
${queueJql}

${CONTRACT}`;
  },
};
