import { promises as fs } from "node:fs";
import path from "node:path";
import type { StatementProfile } from "../engine/types.ts";

// Best-effort persistence of confirmed parsing profiles, keyed by layout fingerprint.
// On Railway, mount a volume and set PROFILE_STORE_DIR to keep profiles across deploys.
const dir = () => process.env.PROFILE_STORE_DIR || path.join(process.cwd(), ".profiles");
const file = (fp: string) => path.join(dir(), `${fp.replace(/[^a-zA-Z0-9_-]/g, "")}.json`);

export async function loadProfile(fingerprint: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file(fingerprint), "utf8"));
  } catch {
    return null;
  }
}

export async function saveProfile(fingerprint: string, profile: StatementProfile): Promise<void> {
  try {
    await fs.mkdir(dir(), { recursive: true });
    await fs.writeFile(file(fingerprint), JSON.stringify(profile, null, 2));
  } catch {
    // read-only filesystem: profiles are simply not persisted
  }
}
