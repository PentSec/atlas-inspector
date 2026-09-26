/**
 * DB2 CSV table parsing (ADR-003): csv-parse replaces the hand-rolled parser.
 * Contract parity with the legacy parser:
 *  - headers in row 1, quoted fields, `""` escapes, CRLF or LF
 *  - empty lines skipped
 *  - missing cells become `""` (never undefined)
 */
import { parse } from "csv-parse/sync";
import type { Db2Row } from "./repo.js";

/** Parse a DB2 CSV table dump into rows keyed by header name. */
export function parseDb2Csv(text: string): Db2Row[] {
    const records = parse(text, {
        columns: true,
        bom: true,
        skip_empty_lines: true,
        relax_column_count: true,
        relax_quotes: false,
    }) as Record<string, unknown>[];
    const out: Db2Row[] = [];
    for (const rec of records) {
        const row: Db2Row = {};
        for (const [k, v] of Object.entries(rec)) {
            row[k] = v === undefined || v === null ? "" : String(v);
        }
        out.push(row);
    }
    return out;
}
