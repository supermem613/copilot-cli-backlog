export const SCHEMA_VERSION = "1.0.0";

const commandDefinitions = [
  {
    name: "backlog",
    scope: "slash",
    description: "Manage backlog queues and items.",
    usage: "/backlog <command> [args]",
  },
  {
    name: "add",
    scope: "slash",
    description: "Add a backlog item.",
    usage: "/backlog add [--top] <description>",
    allowedFlags: ["--top"],
  },
  {
    name: "list",
    scope: "slash",
    description: "List items in the resolved or named queue; default is pending-only, and unrecognized flags are rejected.",
    usage: "/backlog list [queue-id] [--status <value>]",
    allowedFlags: ["--status"],
  },
  {
    name: "move",
    scope: "slash",
    description: "Move an item to a queue position.",
    usage: "/backlog move <id-or-position> <position|top|bottom>",
  },
  {
    name: "done",
    scope: "slash",
    description: "Mark an item as done.",
    usage: "/backlog done <id-or-position>",
  },
  {
    name: "remove",
    scope: "slash",
    description: "Remove an item from the backlog.",
    usage: "/backlog remove <id-or-position>",
  },
  {
    name: "edit",
    scope: "slash",
    description: "Edit a backlog item description.",
    usage: "/backlog edit <id-or-position> <new-description>",
  },
  {
    name: "pending",
    scope: "slash",
    description: "Show the pending item count.",
    usage: "/backlog pending",
  },
  {
    name: "status",
    scope: "slash",
    description: "Inspect backlog queue resolution for the current workspace.",
    usage: "/backlog status",
  },
  {
    name: "init",
    scope: "slash",
    description: "Create or reuse a queue for the current workspace and bind it.",
    usage: "/backlog init [queue-id] [name]",
  },
  {
    name: "clear",
    scope: "slash",
    description: "Clear all backlog items from the resolved queue.",
    usage: "/backlog clear",
  },
  {
    name: "queue",
    scope: "slash",
    description: "Create, inspect, and rename backlog queues.",
    usage: "/backlog queue list [queue-id]|<queue-id> [list]|add|create|edit|rename",
  },
  {
    name: "show",
    scope: "slash",
    description: "Open the backlog viewer.",
    usage: "/backlog show",
  },
  {
    name: "approve",
    scope: "slash",
    description: "Approve the start gate for an item.",
    usage: "/backlog approve <id>",
  },
  {
    name: "review",
    scope: "slash",
    description: "Inspect and decide on review-gated items.",
    usage: "/backlog review [<id> approve|reject]",
  },
  {
    name: "backup",
    scope: "slash",
    description: "Export a backlog backup.",
    usage: "/backlog backup [path]",
  },
  {
    name: "restore",
    scope: "slash",
    description: "Restore a backlog backup.",
    usage: "/backlog restore <path>",
  },
  {
    name: "doctor",
    scope: "slash",
    description: "Show the backlog doctor report.",
    usage: "/backlog doctor",
  },
  {
    name: "help",
    scope: "cli",
    description: "Show help for the backlog CLI.",
    usage: "backlog help [command]",
  },
  {
    name: "schema",
    scope: "cli",
    description: "Show the backlog command and tool schema.",
    usage: "backlog schema",
  },
  {
    name: "commands",
    scope: "cli",
    description: "List CLI commands as structured data.",
    usage: "backlog commands",
  },
  {
    name: "queues",
    scope: "cli",
    description: "List queues with item counts by status.",
    usage: "backlog queues",
  },
];

const toolDefinitions = [
  {
    name: "backlog_list",
    description: "List all pending backlog items for the resolved workspace queue.",
    parameters: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Workspace directory to inspect" },
      },
    },
  },
  {
    name: "backlog_done",
    description: "Mark a backlog item as done by item ID or position number. Pass the item in `ref`; `id` is accepted as an alias.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Item ID or position number" },
        id: { type: "string", description: "Alias for ref. Item ID or position number" },
        cwd: { type: "string", description: "Workspace directory to inspect" },
      },
    },
  },
  {
    name: "backlog_status",
    description: "Inspect the current backlog queue resolution and item counts for a workspace.",
    parameters: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Workspace directory to inspect" },
      },
    },
  },
];

function cloneMetadata(items) {
  return items.map((item) => JSON.parse(JSON.stringify(item)));
}

export function getCommandDefinitions() {
  return cloneMetadata(commandDefinitions);
}

export function getSlashCommandDefinitions() {
  return getCommandDefinitions().filter((command) => command.scope === "slash");
}

export function getSharedCommandDefinitions() {
  return getSlashCommandDefinitions().filter((command) => command.name !== "backlog");
}

export function getCommandDefinition(name) {
  return getCommandDefinitions().find((command) => command.name === name) || null;
}

export function getSlashCommandNames() {
  return getSharedCommandDefinitions().map((command) => command.name);
}

export function getCliCommandNames() {
  return getCommandDefinitions().filter((command) => command.scope === "cli").map((command) => command.name);
}

export function getCliCommandDefinitions() {
  const sharedCommands = getSharedCommandDefinitions().map((command) => ({
    ...command,
    scope: "cli",
    usage: command.usage.replace(/^\/backlog\b/, "backlog"),
  }));
  const cliHelpers = getCommandDefinitions().filter((command) => command.scope === "cli");
  return [...sharedCommands, ...cliHelpers];
}

export function getCliCommandDefinition(name) {
  return getCliCommandDefinitions().find((command) => command.name === name) || null;
}

export function formatCommandHelp(commandName = null) {
  const command = commandName ? getCommandDefinition(commandName) : null;
  if (command) {
    return `${command.name}\n  ${command.description}\n  Usage: ${command.usage}`;
  }

  const lines = ["Usage: backlog <command> [args]", "", "Commands:"]; 
  for (const entry of getSharedCommandDefinitions()) {
    lines.push(`  ${entry.name.padEnd(10)} ${entry.description}`);
  }
  lines.push("", "CLI helpers:");
  for (const entry of getCommandDefinitions().filter((item) => item.scope === "cli")) {
    lines.push(`  ${entry.name.padEnd(10)} ${entry.description}`);
  }
  return lines.join("\n");
}

export function formatCliCommandHelp(commandName = null) {
  const command = commandName ? getCliCommandDefinition(commandName) : null;
  if (command) {
    return `${command.name}\n  ${command.description}\n  Usage: ${command.usage}`;
  }
  return formatCommandHelp();
}

export function getToolDefinitions() {
  return cloneMetadata(toolDefinitions);
}

export function getToolDefinition(name) {
  return getToolDefinitions().find((tool) => tool.name === name) || null;
}

export function createSchemaEnvelope() {
  return {
    schemaVersion: SCHEMA_VERSION,
    commands: getCommandDefinitions(),
    tools: getToolDefinitions(),
  };
}
