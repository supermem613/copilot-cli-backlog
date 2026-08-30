import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { initBacklog } from "./db.mjs";
import {
  SCHEMA_VERSION,
  createSchemaEnvelope,
  formatCliCommandHelp,
  getCliCommandDefinitions,
  getCliCommandNames,
  getCliCommandDefinition,
  getSlashCommandNames,
} from "./command-registry.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseCliArgs(argv) {
  const parsed = {
    cwd: null,
    dbDir: null,
    help: false,
    command: null,
    args: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cwd") {
      parsed.cwd = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (argument === "--db-dir") {
      parsed.dbDir = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (argument.startsWith("--cwd=")) {
      parsed.cwd = argument.slice("--cwd=".length);
      continue;
    }
    if (argument.startsWith("--db-dir=")) {
      parsed.dbDir = argument.slice("--db-dir=".length);
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    if (parsed.command === null) {
      parsed.command = argument;
    } else {
      parsed.args.push(argument);
    }
  }

  if (parsed.command === null) {
    parsed.command = "help";
  }
  if (parsed.cwd) {
    parsed.cwd = resolve(String(parsed.cwd));
  }
  if (parsed.dbDir) {
    parsed.dbDir = resolve(String(parsed.dbDir));
  }
  return parsed;
}

function hasBacklogDatabase(dirPath) {
  return existsSync(join(dirPath, "backlog.db"));
}

function validateCommandArgs(commandName, args) {
  const commandDefinition = getCliCommandDefinition(commandName);
  if (!commandDefinition) return null;

  const allowedFlags = Array.isArray(commandDefinition.allowedFlags)
    ? commandDefinition.allowedFlags
    : [];
  const invalid = args.find((arg) => arg.startsWith("-") && !allowedFlags.includes(arg));
  if (!invalid) return null;

  if (!commandDefinition.usage) {
    return {
      ok: false,
      command: commandName,
      schemaVersion: SCHEMA_VERSION,
      data: {
        error: `Missing canonical ${commandName} usage definition`,
      },
      timingMs: 0,
    };
  }

  return {
    ok: false,
    command: commandName,
    schemaVersion: SCHEMA_VERSION,
    data: {
      error: `Unsupported ${commandName} flag: ${invalid}`,
      help: `Usage: ${commandDefinition.usage}`,
    },
    timingMs: 0,
  };
}

function resolveDatabaseDir(explicitCwd, explicitDbDir = null) {
  if (explicitDbDir) return explicitDbDir;
  const candidates = [];
  if (explicitCwd) {
    candidates.push(explicitCwd, join(explicitCwd, ".backlog"));
  }
  const currentCwd = process.cwd();
  candidates.push(currentCwd, join(currentCwd, ".backlog"));

  for (const candidate of candidates) {
    if (hasBacklogDatabase(candidate)) {
      return candidate;
    }
  }

  return join(homedir(), ".backlog");
}

export async function runCli(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  const commandName = parsed.command || "help";
  const startTime = Date.now();
  let envelope = {
    ok: true,
    command: commandName,
    schemaVersion: SCHEMA_VERSION,
    data: {},
    timingMs: 0,
  };

  try {
    let handleBacklogCommand = null;
    const loadCommandHandler = async () => {
      if (handleBacklogCommand) return handleBacklogCommand;
      const databaseDir = resolveDatabaseDir(parsed.cwd, parsed.dbDir);
      initBacklog(databaseDir);
      ({ handleBacklogCommand } = await import("./commands.mjs"));
      return handleBacklogCommand;
    };

    const commandValidationFailure = validateCommandArgs(commandName, parsed.args);
    if (commandValidationFailure) {
      envelope.ok = false;
      envelope.data = commandValidationFailure.data;
      envelope.command = commandValidationFailure.command;
      envelope.schemaVersion = commandValidationFailure.schemaVersion;
    } else if (parsed.help && commandName !== "help") {
      const commandHelp = formatCliCommandHelp(commandName);
      envelope.data = { help: commandHelp, command: getCliCommandDefinition(commandName) };
    } else if (commandName === "help") {
      const target = parsed.args[0] || null;
      envelope.data = target
        ? { help: formatCliCommandHelp(target), command: getCliCommandDefinition(target) }
        : {
          help: formatCliCommandHelp(),
          commands: getCliCommandDefinitions(),
        };
    } else if (commandName === "schema") {
      envelope.data = createSchemaEnvelope();
    } else if (commandName === "commands") {
      envelope.data = {
        commands: getCliCommandDefinitions(),
      };
    } else if (commandName === "queues") {
      const commandHandler = await loadCommandHandler();
      const result = await commandHandler("queue list", { cwd: parsed.cwd || process.cwd() });
      envelope.data = typeof result === "string" ? { output: result } : result;
    } else if (commandName === "doctor") {
      const commandHandler = await loadCommandHandler();
      const result = await commandHandler("doctor", { cwd: parsed.cwd || process.cwd() });
      envelope.data = typeof result === "string" ? { output: result } : result;
    } else if (getSlashCommandNames().includes(commandName)) {
      const rawText = [commandName, ...parsed.args].join(" ").trim();
      const commandHandler = await loadCommandHandler();
      const result = await commandHandler(rawText, { cwd: parsed.cwd || process.cwd() });
      if (result && typeof result === "object" && result.ok === false) {
        envelope.ok = false;
        delete result.ok;
      }
      envelope.data = typeof result === "string" ? { output: result } : result;
    } else {
      envelope.ok = false;
      envelope.data = {
        error: `Unknown command: ${commandName}`,
        knownCommands: [...getSlashCommandNames(), ...getCliCommandNames()],
      };
    }
  } catch (error) {
    envelope.ok = false;
    envelope.data = { error: error?.message || String(error) };
  }

  envelope.timingMs = Date.now() - startTime;
  if (!envelope.ok) {
    process.exitCode = 1;
  }

  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  return envelope;
}

const isExecutedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isExecutedDirectly) {
  runCli(process.argv.slice(2)).catch((error) => {
    const envelope = {
      ok: false,
      command: "backlog",
      schemaVersion: SCHEMA_VERSION,
      data: { error: error?.message || String(error) },
      timingMs: 0,
    };
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    process.exitCode = 1;
  });
}
