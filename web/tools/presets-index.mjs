#!/usr/bin/env node
// Builds the list of published states presets/index.json from the contents of presets/.
// Usage (from web/):  node tools/presets-index.mjs [folder]
// Every *.json file (except index.json) is validated; an invalid file is an error (CI fails).
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateState, stateSummary, sortStateList } from "../js/state.js";

export const LIST_FORMAT = "dostupnost-kontejneru/list";
const DEFAULT_FOLDER = fileURLToPath(new URL("../presets/", import.meta.url));

/** Scans the folder and returns the contents of index.json. Throws an Error listing the bad files. */
export async function buildList(folder) {
  let files;
  try {
    files = await readdir(folder);
  } catch (e) {
    if (e.code === "ENOENT") files = [];
    else throw e;
  }
  files = files.filter((f) => f.toLowerCase().endsWith(".json") && f.toLowerCase() !== "index.json").sort();
  const entries = [], errors = [];
  for (const f of files) {
    try {
      const o = validateState(JSON.parse(await readFile(join(folder, f), "utf8")));
      entries.push(stateSummary(o, f));
    } catch (e) {
      errors.push(`${f}: ${e instanceof SyntaxError ? "není platný JSON" : e.message}`);
    }
  }
  if (errors.length) throw new Error("Vadné soubory ve složce presets:\n  " + errors.join("\n  "));
  return { format: LIST_FORMAT, version: 1, generated: new Date().toISOString().slice(0, 19), states: sortStateList(entries) };
}

/** Builds the list and writes it to folder/index.json. */
export async function writeList(folder) {
  const list = await buildList(folder);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "index.json"), JSON.stringify(list, null, 1) + "\n");
  return list;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const folder = resolve(process.argv[2] || DEFAULT_FOLDER);
  writeList(folder).then(
    (l) => {
      console.log(`presets/index.json: ${l.states.length} stav(ů)`);
      for (const s of l.states) console.log(`  ${s.file}  „${s.name}“  (${s.containers} kontejnerů)`);
    },
    (e) => { console.error(e.message); process.exit(1); },
  );
}
