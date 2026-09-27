/** Minimal test harness: `test()` registers, `run()` executes and sets the exit code. */

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];

export function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

export async function run(suite: string): Promise<void> {
  console.log(`\n${suite}`);
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${t.name}\n    ${(err as Error).message.split('\n').join('\n    ')}`);
    }
  }
  console.log(`  ${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) { process.exitCode = 1; }
}
