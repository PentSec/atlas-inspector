/**
 * Resolve the `blp` tool argument into raw BLP bytes.
 *
 * The argument accepts EITHER a filesystem path OR base64. Reading the path
 * here is the whole point: an agent that has a .blp on disk should not have to
 * shell out to `base64` and paste 30k characters into a JSON argument, and when
 * it gets that wrong the old unconditional `Buffer.from(blp, "base64")` turned
 * a path into garbage bytes, the API answered 422 "BLP format not supported",
 * and the agent concluded the decoder could not read BLP2. That conclusion was
 * false — the bytes were never a BLP at all.
 *
 * So this resolver fails LOUDLY and names the real problem instead of letting
 * a corrupt payload masquerade as an unsupported format.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const BLP_MAGIC = new Set(["BLP1", "BLP2"]);

const BASE64_SHAPE = /^[A-Za-z0-9+/\r\n]+={0,2}$/;

/** Hard ceiling so a mistyped path cannot pull an arbitrary huge file into memory. */
export const MAX_BLP_BYTES = 64 * 1024 * 1024;

export class BlpInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BlpInputError";
    }
}

/**
 * Decide path vs base64.
 *
 * The base64 alphabet has no `.`, so a dot anywhere in the string is proof it is
 * NOT base64 — that catches the common `Atlas.blp` / `sheet.png` shapes that a
 * prefix check alone misses. Everything else is decided by the explicit path
 * markers, and only a string made purely of base64 characters is treated as
 * base64. An agent passing `RarityGemAtlas.blp` gets a file read, not a decode
 * of nonsense.
 */
function looksLikePath(value: string): boolean {
    if (value.includes("\n")) return false;
    if (value.startsWith("file://")) return true;
    if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return true;
    if (/^[A-Za-z]:[\\/]/.test(value)) return true;
    if (value.includes(".")) return true;
    return !BASE64_SHAPE.test(value);
}

function stripFileUrl(value: string): string {
    return value.startsWith("file://") ? decodeURIComponent(new URL(value).pathname) : value;
}

function describeMagic(bytes: Buffer): string {
    const head = bytes.subarray(0, 4).toString("latin1");
    return head.replace(/[^\x20-\x7e]/g, ".");
}

/**
 * Turn a user/agent-supplied `blp` argument into bytes, rejecting anything that
 * is not a BLP with a message that says which of the two failure modes hit.
 */
export function resolveBlpBytes(input: string, cwd: string = process.cwd()): Buffer {
    const value = input.trim();
    if (!value) throw new BlpInputError("`blp` is empty. Pass a .blp path or base64 bytes.");

    let bytes: Buffer;
    let origin: string;

    if (looksLikePath(value)) {
        const path = isAbsolute(stripFileUrl(value)) ? stripFileUrl(value) : resolve(cwd, value);
        let size: number;
        try {
            const stat = statSync(path);
            if (!stat.isFile()) {
                throw new BlpInputError(`\`blp\` path is not a file: ${path}`);
            }
            size = stat.size;
        } catch (error) {
            if (error instanceof BlpInputError) throw error;
            throw new BlpInputError(
                `\`blp\` looks like a path but cannot be read: ${path}. ` +
                    `Pass an existing .blp file, or pass the raw file bytes as base64.`,
            );
        }
        if (size > MAX_BLP_BYTES) {
            throw new BlpInputError(
                `\`blp\` file is ${size} bytes, over the ${MAX_BLP_BYTES}-byte limit: ${path}`,
            );
        }
        bytes = readFileSync(path);
        origin = `file ${path}`;
    } else {
        const compact = value.replace(/\s+/g, "");
        if (!BASE64_SHAPE.test(compact)) {
            throw new BlpInputError(
                `\`blp\` is neither a readable path nor base64. ` +
                    `Base64 uses only A-Z a-z 0-9 + / and = padding.`,
            );
        }
        bytes = Buffer.from(compact, "base64");
        origin = "base64 argument";
    }

    if (bytes.length < 4) {
        throw new BlpInputError(
            `\`blp\` decoded to only ${bytes.length} byte(s) from ${origin} — that cannot be a BLP.`,
        );
    }

    const magic = bytes.toString("latin1", 0, 4);
    if (!BLP_MAGIC.has(magic)) {
        throw new BlpInputError(
            `\`blp\` from ${origin} starts with "${describeMagic(bytes)}", not BLP1/BLP2. ` +
                `The bytes are not a WoW texture — do not report this as an unsupported BLP version.`,
        );
    }

    return bytes;
}
