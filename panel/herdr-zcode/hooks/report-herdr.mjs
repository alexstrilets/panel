import { spawnSync } from "node:child_process";

let raw = "";
process.stdin.setEncoding("utf8");

for await (const chunk of process.stdin) {
  raw += chunk;
}

// Keep the hook harmless when ZCode runs outside a Herdr-managed pane.
if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
  process.exit(0);
}

let event;

try {
  event = JSON.parse(raw);
} catch {
  process.exit(0);
}

const eventName = event.hook_event_name || event.hookEventName;
const stateByEvent = {
  SessionStart: "idle",
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PermissionRequest: "blocked",
  PostToolUse: "working",
  PostToolUseFailure: "working",
  Stop: "idle",
};
const state = stateByEvent[eventName];

if (!state) {
  process.exit(0);
}

const args = [
  "pane",
  "report-agent",
  process.env.HERDR_PANE_ID,
  "--source",
  "custom:zcode",
  "--agent",
  "zcode",
  "--state",
  state,
];

if (state === "blocked") {
  args.push("--message", "ZCode is waiting for permission or a decision");
}

const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
const result = spawnSync(herdrBin, args, {
  env: process.env,
  stdio: "ignore",
});

if (result.error) {
  process.stderr.write(`[herdr-zcode] ${result.error.message}\n`);
}
