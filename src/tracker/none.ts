// No tracker: work arrives only as local items the human asks for. Nothing reads a queue, so no
// queue watcher is scheduled and the round has no tracker questions to ask.
import type { Tracker } from "./read.js";

export const none: Tracker = {
  kind: "none",
  reads: false,
  tools: [],
  instructions: () => "This workspace has no tracker. Skip every question about one.",
};
