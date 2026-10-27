import { fileURLToPath } from "node:url";
import { CliError } from "./settings.ts";

try {
  const args = process.argv.slice(2);
  if (args[0] === "site") {
    const { runSiteCli } = await import("./site.ts");
    process.exitCode = await runSiteCli(args.slice(1), fileURLToPath(new URL("../../", import.meta.url)));
  } else if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(`Usage: seshat <command> [options]

  site     Set up, update and inspect this checkout's hosted site
  list     List project index entries
  each     Run a command across project checkouts
  check    Check project index format and disk coverage
  survey   Survey local Git signals

Run seshat site --help for hosted operations.
Run seshat <command> --help for project command options.
`);
    process.exitCode = 0;
  } else {
    const { runCli } = await import("./commands.ts");
    process.exitCode = await runCli(args);
  }
} catch (error) {
  // Git failures may contain credential-bearing URLs. Only messages we
  // construct ourselves are printed; external stderr and stacks stay local.
  process.stderr.write(`seshat: ${error instanceof CliError ? error.message : "Could not complete the command; check settings and local directory access."}\n`);
  process.exitCode = 2;
}
