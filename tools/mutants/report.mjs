#!/usr/bin/env node
// Prints one table with the mutation score of every area from the last run.
//
// Reads the reports the three tools already write; it never runs a tool and
// never needs network access:
//
//   client/src-tauri/target/mutants/mutants.out/outcomes.json  (cargo-mutants)
//   server/mutants-<package>.json                              (gremlins)
//   client/ui/reports/mutation.json                            (StrykerJS)
//
// The definitions differ slightly, so each score is computed with that tool's
// own convention (documented in docs/TEST-QUALITY.md):
//
//   Rust  caught / (caught + missed + timeout)          unviable excluded
//   Go    killed / (killed + lived)                     gremlins "efficacy"
//   UI    (killed + timeout) / (killed + timeout + survived + no coverage)
//
// A missing report is reported as "not run", not as a failure.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const uiDir = path.join(root, "client", "ui");
const tauriDir = path.join(root, "client", "src-tauri");
const serverDir = path.join(root, "server");

const percent = (part, total) =>
  total === 0 ? "n/a" : `${((part / total) * 100).toFixed(1)} %`;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function rust() {
  // A run may be split per file or per shard to stay inside the time budget;
  // every `target/mutants*` directory with an outcomes file is merged by mutant
  // name (the same mutant in two runs is counted once).
  const target = path.join(tauriDir, "target");
  let runs = [];
  try {
    runs = fs
      .readdirSync(target)
      .filter((name) => name.startsWith("mutants"))
      .map((name) =>
        readJson(path.join(target, name, "mutants.out", "outcomes.json")),
      )
      .filter(Boolean);
  } catch {
    return { tool: "cargo-mutants", area: "client core", missing: true };
  }
  const byName = new Map();
  for (const report of runs) {
    for (const outcome of report.outcomes ?? []) {
      const name = outcome.scenario?.Mutant?.name;
      if (!name) continue;
      byName.set(name, outcome);
    }
  }
  if (byName.size === 0) {
    return { tool: "cargo-mutants", area: "client core", missing: true };
  }
  const outcomes = [...byName.values()];
  const count = (summary) =>
    outcomes.filter((outcome) => outcome.summary === summary).length;
  const caught = count("CaughtMutant");
  const missed = count("MissedMutant");
  const timeout = count("Timeout");
  const unviable = count("Unviable");
  const judged = caught + missed + timeout;
  const survivors = outcomes
    .filter((outcome) => outcome.summary === "MissedMutant")
    .map((outcome) => outcome.scenario?.Mutant?.name)
    .filter(Boolean);
  return {
    tool: "cargo-mutants",
    area: "client core",
    total: outcomes.length,
    caught,
    timeout,
    missed,
    unviable,
    score: percent(caught + timeout, judged),
    survivors,
  };
}

function go() {
  const packages = ["perms", "roles", "chat", "state"];
  return packages.map((pkg) => {
    const report = readJson(path.join(serverDir, `mutants-${pkg}.json`));
    if (!report) {
      return { tool: "gremlins", area: `server/${pkg}`, missing: true };
    }
    const killed = report.mutants_killed ?? 0;
    const lived = report.mutants_lived ?? 0;
    const notCovered = report.mutants_not_covered ?? 0;
    return {
      tool: "gremlins",
      area: `server/${pkg}`,
      total: killed + lived + notCovered,
      caught: killed,
      timeout: 0,
      missed: lived,
      noCoverage: notCovered,
      unviable: report.mutants_not_viable ?? 0,
      score: percent(killed, killed + lived),
      survivors: (report.files ?? [])
        .flatMap((file) => file.mutations ?? [])
        .filter((mutation) => mutation.status === "LIVED")
        .map((mutation) => `${mutation.type} at line ${mutation.line}`),
    };
  });
}

function ui() {
  const report = readJson(path.join(uiDir, "reports", "mutation.json"));
  if (!report) {
    return { tool: "stryker", area: "ui lib + stores", missing: true };
  }
  const mutants = Object.values(report.files ?? {}).flatMap(
    (file) => file.mutants ?? [],
  );
  const count = (...statuses) =>
    mutants.filter((mutant) => statuses.includes(mutant.status)).length;
  const killed = count("Killed");
  const timeout = count("Timeout");
  const survived = count("Survived");
  const noCoverage = count("NoCoverage");
  const ignored = count("Ignored");
  const compileErrors = count("CompileError", "RuntimeError");
  return {
    tool: "stryker",
    area: "ui lib + stores",
    // Static mutants are excluded by `ignoreStatic` and reported as Ignored;
    // they are not part of the score (docs/TEST-QUALITY.md).
    total: mutants.length - ignored,
    ignored,
    caught: killed,
    timeout,
    missed: survived,
    noCoverage,
    unviable: compileErrors,
    score: percent(killed + timeout, killed + timeout + survived + noCoverage),
    survivors: mutants
      .filter((mutant) => mutant.status === "Survived")
      .map(
        (mutant) =>
          `${mutant.mutatorName} at ${mutant.location?.start?.line ?? "?"}`,
      ),
  };
}

const rows = [rust(), ...go(), ui()];

console.log(
  "| area | tool | mutants | killed | timeout | survived | no cov | unviable | score |",
);
console.log(
  "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
);
let missing = 0;
for (const row of rows) {
  if (row.missing) {
    missing += 1;
    console.log(
      `| ${row.area} | ${row.tool} | - | - | - | - | - | - | not run |`,
    );
    continue;
  }
  console.log(
    `| ${row.area} | ${row.tool} | ${row.total}${row.ignored ? ` (${row.ignored} static ignored)` : ""} | ${row.caught} | ${row.timeout} | ${row.missed} | ${row.noCoverage ?? 0} | ${row.unviable} | ${row.score} |`,
  );
}

if (missing === rows.length) {
  console.log(
    "\nNo reports found. Run `make mutants-rust`, `make mutants-go` or `make mutants-ui` first.",
  );
} else {
  console.log(
    "\nReports: client/ui/reports/mutation/index.html, client/src-tauri/target/mutants/mutants.out, server/mutants-*.json",
  );
}
