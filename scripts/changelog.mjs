// Prepend a CHANGELOG.md section for the version being released.
//
// Runs from the npm `version` lifecycle hook (so `npm_package_version` holds
// the new version). Replaces the old vim-based flow with a plain typed
// prompt: enter one bullet per line, blank line to finish. Non-interactive
// input (piped, or none) falls back to a generic entry so nothing hangs.
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

const version = process.env.npm_package_version;
if (!version) {
  console.error("changelog: npm_package_version is not set");
  process.exit(1);
}

const CHANGELOG = "CHANGELOG.md";

const notes = await new Promise((resolve) => {
  const collected = [];
  if (stdout.isTTY) {
    stdout.write(
      `\nRelease notes for v${version}\n` +
        `Type one bullet per line, then press Enter on an empty line to finish.\n`,
    );
    stdout.write("- ");
  }
  const rl = createInterface({ input: stdin, terminal: false });
  rl.on("line", (raw) => {
    const line = raw.trim();
    if (line === "") {
      rl.close();
      return;
    }
    collected.push(`- ${line}`);
    if (stdin.isTTY) stdout.write("- ");
  });
  rl.on("close", () => resolve(collected));
});

const finalNotes = notes.length ? notes : [`- Release ${version}`];
const section = `## ${version}\n\n${finalNotes.join("\n")}\n`;

const existing = readFileSync(CHANGELOG, "utf8");
const header = "# Changelog\n";
const updated = existing.startsWith(header)
  ? `${header}\n${section}\n${existing.slice(header.length).replace(/^\n+/, "")}`
  : `${header}\n${section}\n${existing}`;

writeFileSync(CHANGELOG, updated);
stdout.write(`\nAdded to ${CHANGELOG}:\n\n${section}\n`);
