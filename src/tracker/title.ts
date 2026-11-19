// The tracker's title for a ticket, for a record that has none: a card never shows a bare key. The
// factory holds no tracker API, so a jira title is the summary the queue watcher last read, and a
// local tracker's is the ticket's own.
import { enabled, exists, load } from "../tickets/store.js";
import { squash } from "../util.js";
import { loadQueueState } from "../watchers/queue.js";
import type { Workspace } from "../workspace.js";

export function trackerTitle(ws: Workspace, key: string): string | undefined {
  if (enabled(ws)) {
    try {
      if (exists(ws, key)) return squash(load(ws, key).title, 90) || undefined;
    } catch {
      // not a key of the local tracker's, a LOCAL- one say
    }
    return undefined;
  }
  return loadQueueState(ws).titles[key];
}
