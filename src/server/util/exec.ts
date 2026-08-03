import { spawn } from 'node:child_process';

/** Keep the tail of a chatty run; only the last lines are ever reported. */
const MAX_OUTPUT_CHARS = 64 * 1024;

export type CommandResult = {
  code: number | null;
  stdout: string;
  /** stdout and stderr together, in arrival order — what a human would have seen. */
  output: string;
  timedOut: boolean;
  /** Set when the process never started, e.g. ENOENT for a missing binary. */
  spawnError: NodeJS.ErrnoException | null;
};

/**
 * Runs an external command to completion and collects its output. Never
 * rejects: a binary that is not installed is an ordinary outcome here, so it
 * comes back as `spawnError` rather than an exception.
 */
export function runCommand(
  command: string,
  args: string[],
  { timeoutMs }: { timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });

    let stdout = '';
    let output = '';
    let timedOut = false;

    const append = (value: string, chunk: unknown) => `${value}${chunk}`.slice(-MAX_OUTPUT_CHARS);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const done = (spawnError: NodeJS.ErrnoException | null, code: number | null) => {
      clearTimeout(timer);
      resolve({ code, stdout, output, timedOut, spawnError });
    };

    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
      output = append(output, chunk);
    });
    child.stderr.on('data', (chunk) => {
      output = append(output, chunk);
    });
    child.on('error', (error) => done(error as NodeJS.ErrnoException, null));
    child.on('close', (code) => done(null, code));
  });
}
