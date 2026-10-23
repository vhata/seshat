import { runCli } from "./commands.ts";
import { CliError } from "./settings.ts";

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  // Git failures may contain credential-bearing URLs. Only messages we
  // construct ourselves are printed; external stderr and stacks stay local.
  process.stderr.write(`seshat: ${error instanceof CliError ? error.message : "Could not complete the command; check settings and local directory access."}\n`);
  process.exitCode = 2;
}
