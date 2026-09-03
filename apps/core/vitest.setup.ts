import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FRIDAY_DATA_DIR = mkdtempSync(join(tmpdir(), "friday-test-"));
