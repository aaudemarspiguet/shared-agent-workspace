// How to start a PATH command on this platform (T151, and saw up before it).
// One place, because getting it wrong twice is how the wake adapter
// reintroduced the exact bug PR #179 fixed for saw up: on Windows an
// npm-installed CLI is a .cmd shim, CreateProcess starts real executables
// only, so a bare spawn of the name raises ENOENT while `where` happily
// reports the tool present. Resolve through `where` (it knows PATHEXT) and
// send a shim through cmd.exe with every part quoted. POSIX passes through.
import { execFileSync } from "node:child_process";

/** Quote one part for cmd.exe, which reads "" as a literal quote. */
export function quoteForCmd(part: string): string {
  return `"${part.replace(/"/g, '""')}"`;
}

export interface Launch {
  file: string;
  args: string[];
  shell: boolean;
}

/** Find the runnable form of a command that lives on PATH. */
export function launchFor(name: string, args: string[]): Launch {
  if (process.platform !== "win32") return { file: name, args, shell: false };
  let target = name;
  try {
    const found = execFileSync("where", [name], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8"
    });
    const first = found
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "");
    if (first) target = first;
  } catch {
    // Not on PATH. Keep the bare name so the spawn reports ENOENT as before.
  }
  if (!/\.(cmd|bat)$/i.test(target)) return { file: target, args, shell: false };
  return { file: quoteForCmd(target), args: args.map(quoteForCmd), shell: true };
}
