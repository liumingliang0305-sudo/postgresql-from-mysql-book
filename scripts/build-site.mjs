import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(projectRoot, "dist");

if (path.basename(outputDirectory) !== "dist") {
  throw new Error("Refusing to clean an unexpected output directory");
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const source of ["index.html", "README.md", "assets", "chapters"]) {
  await cp(path.join(projectRoot, source), path.join(outputDirectory, source), {
    recursive: true,
  });
}

console.log(`Static site built at ${outputDirectory}`);
