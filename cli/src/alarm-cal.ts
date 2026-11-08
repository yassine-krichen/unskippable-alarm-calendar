import { main } from './main';
import { createRuntime } from './runtime';

// The bundle's entry point (esbuild turns this into dist/alarm-cal.cjs).
const argv = process.argv.slice(2);
const runtime = createRuntime({ argv, scriptDir: __dirname });

main(argv, runtime).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
);
