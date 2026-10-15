import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const assetsDirectory = join(projectDirectory, "raycast", "assets");
// Use this installation's Node and backend, never Raycast's GUI PATH or a shell startup file.
execFileSync(process.execPath, [join(projectDirectory, "node_modules", "typescript", "bin", "tsc")], {
  cwd: projectDirectory,
  stdio: "inherit",
});
mkdirSync(assetsDirectory, { recursive: true });
writeFileSync(join(assetsDirectory, "runtime.json"), `${JSON.stringify({
  projectDirectory,
  nodeExecutable: process.execPath,
}, null, 2)}\n`);
console.log("Configured Jimmy automatically using the current repository and Node.js installation.");
