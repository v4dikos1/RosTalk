// StrykerJS configuration for the RosTalk UI (docs/TEST-QUALITY.md).
//
// Scope: the pure logic in src/lib and the zustand stores in src/store that
// already have unit tests. Components, the proto bindings and the IPC layer are
// out of scope: their tests are mostly rendering assertions, and mutating them
// costs minutes per run. Add a file here only together with real tests for it.
//
// Usage (from client/ui):
//   npm run test:mutants
//   npx stryker run --mutate src/lib/link.ts
//
// `break: null` is deliberate: the score is a quality signal, not a build gate
// (see docs/TEST-QUALITY.md). `make check` never runs this configuration.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  vitest: { configFile: "vite.config.ts" },

  mutate: [
    // First wave: security, visibility and state. The rest of src/lib and
    // src/store is intentionally out of the configured scope until a run fits
    // the time budget in docs/TEST-QUALITY.md; see that file for the list of
    // files still to add.
    "src/lib/link.ts",
    "src/lib/permissions.ts",
    "src/lib/quality.ts",
    "src/lib/time.ts",
    "src/store/coreStore.ts",
  ],

  // One mutant at a time can reuse the jsdom environment per test file thanks
  // to perTest coverage analysis (the default). 6 workers use the 6 physical
  // cores of the reference machine; lower it to keep the laptop responsive.
  concurrency: 6,
  coverageAnalysis: "perTest",

  // Static mutants (module-level constants, the permission-name map) need a
  // full module reload for every single one: in `permissions.ts` they were 52 %
  // of the mutants and an estimated 99 % of the runtime. They are excluded;
  // the values are asserted by ordinary round-trip tests instead.
  ignoreStatic: true,

  // The vitest suite already allows 15 s per test (vite.config.ts). A mutant
  // that needs more than 5 s here is a hang (async timers in the stores), and
  // long hangs are also what makes Stryker's taskkill of a stuck vitest child
  // unreliable on Windows.
  timeoutMS: 5000,

  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation.json" },

  // A red flag, not a blocker: mutation score below 60 % is reported but does
  // not fail the command (docs/TEST-QUALITY.md).
  thresholds: { high: 80, low: 60, break: null },

  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
};
