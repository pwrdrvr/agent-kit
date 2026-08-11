import path from "node:path";

const WINDOWS_BATCH_EXTENSION = /\.(?:bat|cmd)$/i;
const WINDOWS_CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

export type CommandInvocation = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean | undefined;
};

function readWindowsEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? env[key] : undefined;
}

function escapeWindowsCmdCommand(command: string): string {
  return command.replace(WINDOWS_CMD_META_CHARACTERS, "^$1");
}

function escapeWindowsCmdArgument(argument: string): string {
  // cmd.exe receives one command string after /c, so preserve the argument
  // boundary explicitly and escape both Windows argv quoting and cmd metacharacters.
  // This is the same non-backtracking quoting strategy used by cross-spawn.
  const escapedQuotes = argument.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
  const escapedTrailingSlashes = escapedQuotes.replace(
    /(?=(\\+?)?)\1$/,
    "$1$1",
  );
  return `"${escapedTrailingSlashes}"`.replace(WINDOWS_CMD_META_CHARACTERS, "^$1");
}

/**
 * Build a process-safe invocation for a resolved command. Native executables
 * retain normal argv handling; Windows batch shims are routed through cmd.exe
 * because CreateProcess cannot execute `.cmd` or `.bat` files directly.
 */
export function createCommandInvocation(params: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | undefined;
}): CommandInvocation {
  const platform = params.platform ?? process.platform;
  if (
    platform !== "win32"
    || !WINDOWS_BATCH_EXTENSION.test(path.win32.extname(params.command))
  ) {
    return { command: params.command, args: params.args };
  }

  // Invoke cmd.exe directly instead of enabling child_process `shell`, which
  // would interpolate the command and args without an explicit safety boundary.
  const shellCommand = [
    escapeWindowsCmdCommand(path.win32.normalize(params.command)),
    ...params.args.map(escapeWindowsCmdArgument),
  ].join(" ");

  return {
    command: readWindowsEnv(params.env, "ComSpec")?.trim() || "cmd.exe",
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}
