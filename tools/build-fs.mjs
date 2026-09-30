#!/usr/bin/env node
/**
 * build-fs.mjs -- debug / release build for the Onshape FeatureScript documents.
 *
 * Onshape has no compiler and no preprocessor, so the only way to ship a
 * FeatureScript without the development chatter is to strip it here and hand
 * Onshape the stripped file.  The stripping is deliberately conservative:
 * anything the tool does not positively recognise is either kept or reported
 * as an error, never silently dropped.
 *
 *   node tools/build-fs.mjs                        dev build     -> dist/featurescript/dev
 *   node tools/build-fs.mjs --release              release build -> dist/featurescript/release
 *   node tools/build-fs.mjs --release --check      validate only, write nothing
 *   node tools/build-fs.mjs --release --out /tmp/x write somewhere else
 *   node tools/build-fs.mjs --release --no-deadcode  keep helper funcs
 *   node tools/build-fs.mjs --config FILE          use a different build config
 *
 * The mode (dev or release) decides whether the debug statements are stripped;
 * it comes from the config's "mode" unless a flag says otherwise.  A release
 * build also fills the Onshape document ids, which the sources leave blank on
 * purpose: see the build-config section below.
 *
 * A release build removes:
 *   1. `const DEBUG_FOO = ...;` declarations, and the TEMPORARY/DEBUG note
 *      directly above them.
 *   2. `if (DEBUG_FOO) { ... }` and `else if (DEBUG_FOO) { ... }` branches.  A
 *      following `else` is preserved (the whole `if ... else` head is what
 *      goes), so an `if (DEBUG) { log } else { real work }` still works.
 *   3. Every `println(...)` statement, unless the line above it says
 *      `// @keep` -- that is how a warning a user should still see is opted
 *      back in.
 *   4. Top-level helper functions that the release build orphaned, i.e. that
 *      the source referenced but the output does not.  This is what takes the
 *      diagnostics' helpers (`describeSection`, `reportTabSketchCurves`, ...)
 *      with them.  The whole document set is searched, because such a helper is
 *      often exported and only called from another file's debug branch.  A
 *      function already unused in the source is left alone.
 *   5. `if (...) { }` blocks the removals emptied, unless an `else` follows
 *      them (removing those would strand the `else`).
 *   6. What the removals left dangling, which Feature Studio reports as
 *      "Variable x set but not used": a `catch (e)` binding nothing reads any
 *      more becomes `catch { }`, and a local that is assigned but never read
 *      goes with its assignments.  A literal initialiser only, since anything
 *      else may have side effects.
 *
 * Constructs the tool refuses rather than guess at (exit 1, nothing written):
 *   `!DEBUG_FOO` in a condition, an unbraced debug branch, a `println` that is
 *   not a statement.  Caught afterwards by validation: a debug flag that
 *   survived (e.g. one used in an expression such as `DEBUG_FOO ? a : b`), a
 *   call to a helper the build removed, unbalanced brackets, an unterminated
 *   string or block comment, an `else` with no `if` in front of it.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'osFeature');

// A build failure THROWS rather than calling process.exit: stdout is async when
// it is a pipe or a file, and exiting immediately would swallow the report.
class BuildError extends Error {}

function fail(message) {
    throw new BuildError(message);
}

function usage() {
    return [
        'node tools/build-fs.mjs [mode] [--check] [--no-deadcode] [--out DIR] [--config FILE] [file.fs ...]',
        '',
        '  mode (default from the config, else dev)',
        '    --dev, --debug    keep the println diagnostics (alias)',
        '    --release         strip them',
        '  --check             run the transform + validation, write nothing',
        '  --no-deadcode       keep helper functions the strip would orphan',
        '  --out DIR           write somewhere else',
        `  --config FILE       the build config (default ${BUILD_CONFIG}, untracked)`,
        '',
    ].join('\n');
}

function parseArgs(argv) {
    // `mode` is null until something asks for one: the config decides, and only
    // then does the default (dev) apply.
    const options = { mode: null, check: false, deadcode: true, out: null, files: [], help: false, config: BUILD_CONFIG };

    for (let i = 0; i < argv.length; i += 1)
    {
        const arg = argv[i];
        if (arg === '--release')
        {
            options.mode = 'release';
        }
        else if (arg === '--dev' || arg === '--debug')
        {
            options.mode = 'dev';
        }
        else if (arg === '--check')
        {
            options.check = true;
        }
        else if (arg === '--no-deadcode')
        {
            options.deadcode = false;
        }
        else if (arg === '--out')
        {
            options.out = resolve(ROOT, argv[++i] ?? '');
        }
        else if (arg === '--config')
        {
            options.config = resolve(ROOT, argv[++i] ?? '');
        }
        else if (arg === '--help' || arg === '-h')
        {
            options.help = true;
        }
        else if (arg.startsWith('-'))
        {
            fail(`unknown option "${arg}"\n\n${usage()}`);
        }
        else
        {
            options.files.push(arg);
        }
    }

    // Only catches `--check --dev` here; a config that resolves to dev is caught
    // in main(), once the mode is known.
    if (options.check && options.mode === 'dev')
    {
        fail('--check only makes sense for a release build (--release, or "mode": "release")');
    }

    return options;
}

// ------------------------------------------------------------ masking
//
// `mask[i]` is true when `source[i]` is real code -- not inside a string
// literal, a line comment or a block comment.  Every search and every bracket
// count below goes through the mask, so a `DEBUG_FOO` inside a comment, or a
// `"}"` inside a log message, can never be mistaken for code.

function maskSource(source) {
    const mask = new Array(source.length).fill(true);
    let i = 0;

    while (i < source.length)
    {
        const ch = source[i];

        if (ch === '/' && source[i + 1] === '/')
        {
            while (i < source.length && source[i] !== '\n')
            {
                mask[i] = false;
                i += 1;
            }
        }
        else if (ch === '/' && source[i + 1] === '*')
        {
            const end = source.indexOf('*/', i + 2);
            const stop = end < 0 ? source.length : end + 2;
            for (; i < stop; i += 1)
            {
                mask[i] = false;
            }
        }
        else if (ch === '"')
        {
            mask[i] = false;
            i += 1;
            while (i < source.length && source[i] !== '"' && source[i] !== '\n')
            {
                mask[i] = false;
                if (source[i] === '\\')
                {
                    mask[i + 1] = false;
                    i += 2;
                    continue;
                }
                i += 1;
            }
            if (source[i] === '"')
            {
                mask[i] = false;
                i += 1;
            }
        }
        else
        {
            i += 1;
        }
    }

    return mask;
}

function isCode(mask, index) {
    return index >= 0 && index < mask.length && mask[index] === true;
}

function codeText(source, mask, from, to) {
    let text = '';
    for (let i = from; i < to; i += 1)
    {
        text += mask[i] ? source[i] : (source[i] === '\n' ? '\n' : ' ');
    }
    return text;
}

function codeRegex(source, mask, word) {
    return new RegExp(`(?<![\\w.$])${word.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
}

// A regex hit only counts when every character of the match is code.
function findCode(source, mask, pattern, from) {
    const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
    const re = new RegExp(pattern.source, flags);
    let match;
    while ((match = re.exec(source)) !== null)
    {
        if (match.index < from)
        {
            continue;
        }
        let clean = true;
        for (let i = match.index; i < match.index + match[0].length; i += 1)
        {
            if (!isCode(mask, i))
            {
                clean = false;
                break;
            }
        }
        if (clean)
        {
            return match;
        }
    }
    return null;
}

function countWord(source, mask, word) {
    const re = codeRegex(source, mask, word);
    let count = 0;
    let match;
    while ((match = re.exec(source)) !== null)
    {
        let clean = true;
        for (let i = match.index; i < match.index + match[0].length; i += 1)
        {
            if (!isCode(mask, i))
            {
                clean = false;
                break;
            }
        }
        if (clean)
        {
            count += 1;
        }
    }
    return count;
}

function lineOf(source, index) {
    let line = 1;
    for (let i = 0; i < index && i < source.length; i += 1)
    {
        if (source[i] === '\n')
        {
            line += 1;
        }
    }
    return line;
}

// ------------------------------------------------------ bracket walking

const CLOSERS = { '(': ')', '[': ']', '{': '}' };

function matchBracket(source, mask, openIndex) {
    const open = source[openIndex];
    const close = CLOSERS[open];
    if (close === undefined)
    {
        fail(`internal error: "${open}" at offset ${openIndex} is not an opening bracket`);
    }

    let depth = 0;
    for (let i = openIndex; i < source.length; i += 1)
    {
        if (!isCode(mask, i))
        {
            continue;
        }
        if (source[i] === open)
        {
            depth += 1;
        }
        else if (source[i] === close)
        {
            depth -= 1;
            if (depth === 0)
            {
                return i;
            }
        }
    }
    return -1;
}

// End of the statement starting at `start`: the `;` index, or the index just
// past a braced block.
function endOfStatement(source, mask, start) {
    for (let i = start; i < source.length; i += 1)
    {
        if (!isCode(mask, i))
        {
            continue;
        }
        const ch = source[i];
        if (ch === '(' || ch === '[' || ch === '{')
        {
            const close = matchBracket(source, mask, i);
            if (close < 0)
            {
                return -1;
            }
            if (ch === '{')
            {
                return close + 1;
            }
            i = close;
            continue;
        }
        if (ch === ';')
        {
            return i;
        }
        if (ch === '}')
        {
            return i + 1;
        }
    }
    return -1;
}

function skipSpace(source, mask, from) {
    let i = from;
    while (i < source.length && isCode(mask, i) && /\s/.test(source[i]))
    {
        i += 1;
    }
    return i;
}

function prevCodeIndex(source, mask, index) {
    for (let i = index - 1; i >= 0; i -= 1)
    {
        if (isCode(mask, i) && !/\s/.test(source[i]))
        {
            return i;
        }
    }
    return -1;
}

function nextCodeIndex(source, mask, index) {
    for (let i = index; i < source.length; i += 1)
    {
        if (isCode(mask, i) && !/\s/.test(source[i]))
        {
            return i;
        }
    }
    return -1;
}

// -------------------------------------------------------------- editing
//
// Edits are recorded as { start, end, text, note } against the ORIGINAL text
// and applied right-to-left, so earlier offsets stay valid.  An overlap means a
// bug in this tool, and applyEdits fails loudly rather than emitting garbage.

// Pull a removal back to the start of its line when only indentation precedes
// it, so stripping a statement does not leave its leading spaces behind.
function expandToLineStart(source, index) {
    let start = index;
    while (start > 0 && (source[start - 1] === ' ' || source[start - 1] === '\t'))
    {
        start -= 1;
    }
    return start === 0 || source[start - 1] === '\n' ? start : index;
}

// Swallow the rest of the line when a removal leaves nothing else on it, so
// stripping a println does not leave a blank line behind.  A line that still
// holds code keeps its newline.
function eatTrailingLine(source, end) {
    let i = end;
    while (i < source.length && (source[i] === ' ' || source[i] === '\t' || source[i] === '\r'))
    {
        i += 1;
    }
    return source[i] === '\n' ? i + 1 : end;
}

function applyEdits(source, edits) {
    const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < sorted.length; i += 1)
    {
        if (sorted[i].start < sorted[i - 1].end)
        {
            fail(`internal error: overlapping edits at ${sorted[i - 1].start}..${sorted[i - 1].end}`
                + ` and ${sorted[i].start}..${sorted[i].end}`);
        }
    }

    let out = source;
    for (let i = sorted.length - 1; i >= 0; i -= 1)
    {
        out = out.slice(0, sorted[i].start) + sorted[i].text + out.slice(sorted[i].end);
    }
    return out;
}

// Start of the comment block sitting directly above `index`, when that block is
// a debug note (a TEMPORARY/DEBUG line comment, or the doc comment of a
// declaration that is going away).  A comment explaining surviving code, or one
// separated by a blank line, is left alone.
function triviaStart(source, index, { docComment = false } = {}) {
    let start = index;
    const above = []; // the contiguous run of `//` lines directly above

    for (;;)
    {
        // End of the line `start` sits on, ignoring that line's indentation.
        let lineEnd = start;
        while (lineEnd > 0 && (source[lineEnd - 1] === ' ' || source[lineEnd - 1] === '\t'
            || source[lineEnd - 1] === '\r'))
        {
            lineEnd -= 1;
        }
        if (lineEnd === 0 || source[lineEnd - 1] !== '\n')
        {
            break; // not at the start of a line, or the top of the file
        }

        // The line above it, trimmed.  ONE line at a time: skipping runs of
        // whitespace would jump over the newline and pick up the wrong line.
        const prevLineEnd = lineEnd - 1;
        let lineStart = prevLineEnd;
        while (lineStart > 0 && source[lineStart - 1] !== '\n')
        {
            lineStart -= 1;
        }
        const line = source.slice(lineStart, prevLineEnd).trim();

        if (line === '')
        {
            break; // a blank line: whatever is above it is not about this
        }

        if (line.startsWith('//'))
        {
            above.push({ start: lineStart, line });
            start = lineStart;
            continue;
        }

        if (docComment && line.endsWith('*/'))
        {
            const blockStart = source.lastIndexOf('/**', lineStart);
            if (blockStart < 0)
            {
                break;
            }
            start = blockStart;
            continue;
        }

        break;
    }

    // The whole run goes, but only when one of its lines marks it as a debug
    // note.  A note is usually wrapped, and only its first line says TEMPORARY;
    // a comment that merely explains surviving code is left alone.  The run was
    // collected upwards, so its top is the smallest offset.
    if (above.some((entry) => /TEMPORARY|DEBUG|debug/i.test(entry.line)))
    {
        start = Math.min(...above.map((entry) => entry.start));
    }

    return start;
}

const DEBUG_FLAG = /\bDEBUG_[A-Z0-9_]+\b/;

// Strippable only when the flag is tested as TRUE.  A negated test keeps real
// work in its else branch, so the tool refuses to guess there.
function debugConditionVerdict(condition) {
    const text = condition.trim();
    if (!DEBUG_FLAG.test(text))
    {
        return 'no';
    }
    if (/!/.test(text.replace(/!=/g, '').replace(/!==/g, '')))
    {
        return 'negated';
    }
    return 'yes';
}

// Is the next code token this if's `else`, rather than an identifier starting
// with "else"?  FeatureScript has no such identifier, so the word test is
// enough.
function elseFollows(source, mask, afterBody) {
    const next = nextCodeIndex(source, mask, afterBody);
    return next >= 0 && source.slice(next, next + 4) === 'else'
        && !/[A-Za-z0-9_$]/.test(source[next + 4] ?? ' ');
}

function collectFlagEdits(source, mask) {
    const edits = [];
    const pattern = /\b(?:const|var)\s+DEBUG_[A-Z0-9_]+/g;
    let from = 0;

    for (;;)
    {
        const decl = findCode(source, mask, pattern, from);
        if (decl === null)
        {
            break;
        }
        const name = /DEBUG_[A-Z0-9_]+/.exec(source.slice(decl.index))[0];
        const end = endOfStatement(source, mask, decl.index);
        if (end < 0)
        {
            fail(`line ${lineOf(source, decl.index)}: cannot find the end of the ${name} declaration`);
        }
        edits.push({
            start: expandToLineStart(source, triviaStart(source, decl.index)),
            end: source[end] === ';' ? end + 1 : end,
            text: '',
            note: `${name} declaration`,
        });
        from = end + 1;
    }

    return edits;
}

function collectDebugBranchEdits(source, mask) {
    const edits = [];
    let from = 0;

    for (;;)
    {
        const found = findCode(source, mask, /\bif\s*\(/g, from);
        if (found === null)
        {
            break;
        }
        const parenIndex = found.index + found[0].lastIndexOf('(');
        const close = matchBracket(source, mask, parenIndex);
        if (close < 0)
        {
            fail(`line ${lineOf(source, parenIndex)}: unbalanced parentheses in an if condition`);
        }
        const condition = codeText(source, mask, parenIndex + 1, close);
        const verdict = debugConditionVerdict(condition);
        if (verdict === 'negated')
        {
            fail(`line ${lineOf(source, found.index)}: \`if (${condition.trim()})\` negates a debug flag.\n`
                + '        Real work would sit in the else branch, so the release build will not\n'
                + '        guess. Rewrite it as `if (DEBUG_FOO) { log } else { real work }`.');
        }
        if (verdict === 'no')
        {
            from = close + 1;
            continue;
        }

        const bodyStart = skipSpace(source, mask, close + 1);
        if (source[bodyStart] !== '{')
        {
            fail(`line ${lineOf(source, found.index)}: the debug branch \`if (${condition.trim()})\` has no\n`
                + '        braced body, so it cannot be removed safely. Add braces.');
        }
        const bodyEnd = matchBracket(source, mask, bodyStart);
        if (bodyEnd < 0)
        {
            fail(`line ${lineOf(source, found.index)}: unbalanced braces in the debug branch`);
        }

        // An `else` after the debug branch holds real code, so the removal
        // swallows the `if ... } else` head and leaves what follows intact.
        let end = bodyEnd + 1;
        if (elseFollows(source, mask, end))
        {
            end = skipSpace(source, mask, nextCodeIndex(source, mask, end) + 4);
        }

        // Likewise an `else` BEFORE it: `else if (DEBUG) { log }` would
        // otherwise leave a dangling `else` in front of whatever comes next.
        let start = triviaStart(source, found.index);
        const before = prevCodeIndex(source, mask, start);
        if (before >= 0 && source.slice(before - 3, before + 1) === 'else')
        {
            start = triviaStart(source, before - 3);
        }

        edits.push({
            start: expandToLineStart(source, start),
            end,
            text: '',
            note: `debug branch if (${condition.trim()})`,
        });
        from = bodyEnd + 1;
    }

    return edits;
}

// A `// @keep` note in the comment lines directly above a statement opts it out
// of the println sweep, so a warning a user should still see can be kept.
function hasKeepMarker(source, index) {
    const lines = source.slice(Math.max(0, index - 400), index).split('\n');
    for (let i = lines.length - 2; i >= 0 && i >= lines.length - 6; i -= 1)
    {
        const line = lines[i].trim();
        if (line.startsWith('//'))
        {
            if (/@keep\b/.test(line))
            {
                return true;
            }
            continue;
        }
        if (line === '')
        {
            return false;
        }
        return false; // hit code, so the note is not about this statement
    }
    return false;
}

function collectPrintlnEdits(source, mask) {
    const edits = [];
    let from = 0;

    for (;;)
    {
        const found = findCode(source, mask, /(?<![\w.$])println\s*\(/g, from);
        if (found === null)
        {
            break;
        }
        const parenIndex = found.index + found[0].lastIndexOf('(');
        const close = matchBracket(source, mask, parenIndex);
        if (close < 0)
        {
            fail(`line ${lineOf(source, parenIndex)}: unbalanced parentheses in a println call`);
        }
        const semi = nextCodeIndex(source, mask, close + 1);
        if (semi < 0 || source[semi] !== ';')
        {
            fail(`line ${lineOf(source, found.index)}: println is not a statement here, so the release\n`
                + '        build will not touch it.');
        }

        const prev = prevCodeIndex(source, mask, found.index);
        if (prev >= 0 && !'{;}'.includes(source[prev]))
        {
            fail(`line ${lineOf(source, found.index)}: println is not at the start of a statement, so the\n`
                + '        release build will not touch it.');
        }

        from = semi + 1;
        if (hasKeepMarker(source, found.index))
        {
            continue;
        }

        edits.push({
            start: expandToLineStart(source, triviaStart(source, found.index)),
            end: semi + 1,
            text: '',
            note: 'println statement',
        });
    }

    return edits;
}

// Phase two: helpers the phase-one removals orphaned.  The whole document set
// is searched at once, because a debug-only helper is often EXPORTED and only
// called from another file -- `reportTabSketchCurves` is the case in point: once
// main.fs has dropped its debug call, nothing calls it any more.
//
// A function that was ALREADY unused in the source is left alone, so the tool
// never deletes code it did not itself make dead.
function removeOrphans(docs) {
    const removedNames = [];

    // The corpus is rebuilt every pass: dropping one helper can orphan the next
    // (describeSection -> minRadiusOf -> shoulderSummary), and a stale corpus
    // would not see that.
    for (let pass = 0; pass < 20; pass += 1)
    {
        const corpus = docs.map((d) => d.text).join('\n');
        const corpusMask = maskSource(corpus);
        const sourceCorpus = docs.map((d) => d.source).join('\n');
        const sourceCorpusMask = maskSource(sourceCorpus);
        let removedThisPass = false;

        for (const doc of docs)
        {
            const mask = maskSource(doc.text);
            const edits = [];
            const names = [];

            for (let from = 0; ; )
            {
                const found = findCode(doc.text, mask, /^(?:export\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/gm, from);
                if (found === null)
                {
                    break;
                }
                from = found.index + found[0].length;

                const name = /function\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(found[0])[1];
                if (countWord(corpus, corpusMask, name) !== 1)
                {
                    continue; // still called from somewhere
                }
                if (countWord(sourceCorpus, sourceCorpusMask, name) < 2)
                {
                    continue; // already dead in the source: not ours to delete
                }
                if (names.includes(name))
                {
                    continue;
                }

                const brace = findCode(doc.text, mask, /\{/g, found.index);
                const bodyEnd = matchBracket(doc.text, mask, brace.index);
                names.push(name);
                edits.push({
                    start: expandToLineStart(doc.text,
                        triviaStart(doc.text, found.index, { docComment: true })),
                    end: bodyEnd + 1,
                    text: '',
                    note: `orphaned helper ${name}()`,
                });
            }

            if (edits.length === 0)
            {
                continue;
            }
            for (const edit of edits)
            {
                doc.notes.push({ line: lineOf(doc.text, edit.start), note: edit.note });
                edit.end = eatTrailingLine(doc.text, edit.end);
            }
            doc.text = applyEdits(doc.text, edits);
            removedNames.push(...names);
            removedThisPass = true;
        }

        if (!removedThisPass)
        {
            break;
        }
    }

    return removedNames;
}


// -------------------------------------------------------------- build config
//
// Two things the sources deliberately do NOT carry, because both belong to the
// person running the build rather than to the repository:
//
//   1. The Onshape *document ids*.  An import naming a Feature Studio tab this
//      project is pasted into, or an uploaded icon/image, points at an id that
//      belongs to whoever made that document and changes with every version.
//      The sources leave them blank and tag the line, and the build fills them:
//
//          import(path : "", version : ""); // @import utils
//
//      `onshape/std/...` imports are NOT touched: they are released with the
//      `FeatureScript N;` header, not per document, so they are the same for
//      everyone and belong in the source.
//
//   2. The mode.  `dev` keeps the `println` diagnostics in the output;
//      `release` strips them.  A command-line flag wins over the config, so CI
//      can ask for a release build on a checkout that has no config at all.

const BUILD_CONFIG = 'local/build-config.json';
const BUILD_CONFIG_EXAMPLE = 'tools/build-config.example.json';

const MODES = ['dev', 'release'];

// A whole import statement on one line, capturing the id-bearing parts and the
// trailing comment separately.  Anchored, so a string merely *containing*
// "import(" cannot match.
const IMPORT_STMT = /^([ \t]*)((?:\w+\s*::\s*)?import\s*\(\s*path\s*:\s*)"([^"]*)"(\s*,\s*version\s*:\s*)"([^"]*)"(\s*\))(.*)$/;

// The `// @import <key>` tag on the end of a blank import line.
const IMPORT_TAG = /@import\s+(\S+)\s*$/;

/**
 * Read and shape-check the build config.  A missing file is not an error: it
 * yields a config with no mode and no imports, and the caller decides what that
 * means (a dev build is fine without one, a release build is not).
 */
function loadConfig(path) {
    const empty = { mode: null, imports: {} };
    if (!existsSync(path))
    {
        return empty;
    }

    let parsed;
    try
    {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (error)
    {
        fail(`${showPath(path)} is not valid JSON: ${error.message}`);
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    {
        fail(`${showPath(path)} must be a JSON object`);
    }

    // An unknown key is an error rather than a shrug: a misspelt "imprts" would
    // otherwise load as a config with no imports in it, and the ids would go
    // missing one run later instead of here.
    const known = new Set(['mode', 'imports']);
    for (const key of Object.keys(parsed))
    {
        if (!known.has(key))
        {
            fail(`${showPath(path)}: unknown key "${key}"`
                + ` (this file takes: ${[...known].join(', ')})`);
        }
    }

    let mode = null;
    if (parsed.mode !== undefined)
    {
        if (!MODES.includes(parsed.mode))
        {
            fail(`${showPath(path)}: "mode" must be one of ${MODES.join(', ')}`
                + `, not ${JSON.stringify(parsed.mode)}`);
        }
        mode = parsed.mode;
    }

    const raw = parsed.imports ?? {};
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    {
        fail(`${showPath(path)}: "imports" must be an object of key -> { path, version }`);
    }

    const imports = {};
    for (const [key, value] of Object.entries(raw))
    {
        if (value === null || typeof value !== 'object' || Array.isArray(value))
        {
            fail(`${showPath(path)}: "imports.${key}" must be an object of { path, version }`);
        }
        for (const field of ['path', 'version'])
        {
            if (typeof value[field] !== 'string' || value[field].trim() === '')
            {
                fail(`${showPath(path)}: "imports.${key}.${field}" must be a non-empty string`
                    + ' -- copy the whole import line out of Feature Studio');
            }
        }
        imports[key] = value;
    }

    return { mode, imports };
}

/**
 * Fill the blank imports in one document.  `imports` may be {}, which leaves
 * them blank (a debug build with no config yet); `strict` then decides whether
 * a key it cannot resolve is an error or just left for a later run.  The
 * release build is always strict, so an unfilled id can never be published.
 *
 * Returns { text, used }.  Throws on anything it would otherwise have to guess.
 */
function fillImports(text, imports, name, strict = true, configPath = BUILD_CONFIG) {
    const used = [];
    const problems = [];
    let changed = false;

    const out = text.split('\n').map((line, i) => {
        const match = IMPORT_STMT.exec(line);
        if (match === null)
        {
            return line;
        }

        const [, indent, head, path, mid, version, tail, comment] = match;

        // The std imports are versioned with the header, not per document.
        if (path.startsWith('onshape/std/'))
        {
            return line;
        }

        if (path !== '' || version !== '')
        {
            problems.push(`line ${i + 1}: a document id is written out in the source.`
                + ' Leave path and version blank and tag the line `// @import <key>`,'
                + ` so the id stays in ${configPath}.`);
            return line;
        }

        const tag = IMPORT_TAG.exec(comment.trim());
        if (tag === null)
        {
            problems.push(`line ${i + 1}: a blank import with no \`// @import <key>\` tag,`
                + ' so the build cannot tell which document it means.');
            return line;
        }

        const key = tag[1];
        const entry = imports[key];
        if (entry === undefined)
        {
            if (!strict)
            {
                return line; // no config yet: leave it blank, fill it next run
            }
            const known = Object.keys(imports).sort().join(', ') || 'none';
            problems.push(`line ${i + 1}: @import ${key} is not in ${configPath}`
                + ` (it has: ${known}).`);
            return line;
        }

        used.push(key);
        changed = true;
        return `${indent}${head}"${entry.path}"${mid}"${entry.version}"${tail}${comment}`;
    });

    if (problems.length > 0)
    {
        fail(`${name}:\n  ${problems.join('\n  ')}`);
    }

    return { text: changed ? out.join('\n') : text, used };
}

// --------------------------------------------------------------- banner

// Onshape needs `FeatureScript N;` and the imports at the top of the document,
// so the banner goes after them.
function insertBanner(text, header) {
    const lines = text.split('\n');
    let last = 0;
    for (let i = 0; i < lines.length; i += 1)
    {
        // A namespace prefix (`icon::import(...)`) is legal, so allow one.
        if (/^\s*(?:import\s*\(|\w+\s*::\s*import\s*\(|FeatureScript\s)/.test(lines[i]))
        {
            last = i;
        }
        if (lines[i].trim() === '')
        {
            break;
        }
    }
    lines.splice(last + 1, 0, header, '');
    return lines.join('\n');
}

function banner(mode, name) {
    if (mode === 'release')
    {
        return [
            '// ------------------------------------------------------------------',
            `// GENERATED FILE -- ${name} (release) -- do not edit; edit osFeature/${name}.`,
            '// Built by tools/build-fs.mjs --release: debug statements, debug flags and',
            '// the helpers only they used have been removed.',
            '// ------------------------------------------------------------------',
        ].join('\n');
    }
    return [
        '// ------------------------------------------------------------------',
        `// GENERATED FILE -- ${name} (dev) -- do not edit; edit osFeature/${name}.`,
        '// Built by tools/build-fs.mjs in dev mode. Behaviour is identical to the',
        '// source, diagnostics included; this is a copy to paste into Feature Studio.',
        '// ------------------------------------------------------------------',
    ].join('\n');
}

// ----------------------------------------------------------- validation

function validate(name, text, removedNames) {
    const mask = maskSource(text);
    const problems = [];

    const flag = findCode(text, mask, /\bDEBUG_[A-Z0-9_]+/g, 0);
    if (flag !== null)
    {
        problems.push(`line ${lineOf(text, flag.index)}: the debug flag `
            + `${/DEBUG_[A-Z0-9_]+/.exec(text.slice(flag.index))[0]} survived the release build`);
    }

    for (const gone of removedNames)
    {
        if (countWord(text, mask, gone) > 0)
        {
            const at = codeRegex(text, mask, gone).exec(text);
            problems.push(`line ${lineOf(text, at.index)}: ${gone}() was removed as debug-only `
                + 'but is still called from the release build');
        }
    }

    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']])
    {
        let depth = 0;
        let lowest = 0;
        for (let i = 0; i < text.length; i += 1)
        {
            if (!isCode(mask, i))
            {
                continue;
            }
            if (text[i] === open)
            {
                depth += 1;
            }
            else if (text[i] === close)
            {
                depth -= 1;
                lowest = Math.min(lowest, depth);
            }
        }
        if (depth !== 0 || lowest !== 0)
        {
            problems.push(`unbalanced "${open}${close}"`
                + (depth > 0 ? `: ${depth} unclosed` : `: ${-lowest} too many closed`));
        }
    }

    // An `else` can only follow the closing brace of an `if`/`for`/`while`
    // body.  Anything else means a removal took the `if` with it, which is
    // exactly the mistake this check exists to catch.
    const danglingElse = findCode(text, mask, /(?<![\w.$])else(?![\w$])/g, 0);
    if (danglingElse !== null)
    {
        const before = prevCodeIndex(text, mask, danglingElse.index);
        if (before < 0 || text[before] !== '}')
        {
            problems.push(`line ${lineOf(text, danglingElse.index)}: \`else\` with no \`if\` in front of it`);
        }
    }

    if (unterminatedComment(text))
    {
        problems.push('an unterminated block comment');
    }
    if (unterminatedString(text))
    {
        problems.push('an unterminated string literal');
    }

    void name;
    return problems;
}

function unterminatedComment(text) {
    for (let i = 0; i < text.length; i += 1)
    {
        if (text[i] === '/' && text[i + 1] === '*' && !text.slice(i).includes('*/'))
        {
            return true;
        }
        if (text[i] === '/' && text[i + 1] === '/')
        {
            i = text.indexOf('\n', i);
            if (i < 0)
            {
                break;
            }
        }
    }
    return false;
}

// A string literal may span lines in FeatureScript, so this has to scan rather
// than count quotes per line.
function unterminatedString(text) {
    let i = 0;
    while (i < text.length)
    {
        const ch = text[i];

        if (ch === '/' && text[i + 1] === '/')
        {
            i = text.indexOf('\n', i);
            if (i < 0)
            {
                return false;
            }
            continue;
        }
        if (ch === '/' && text[i + 1] === '*')
        {
            const end = text.indexOf('*/', i + 2);
            if (end < 0)
            {
                return false; // unterminatedComment reports this one
            }
            i = end + 2;
            continue;
        }
        if (ch === '"')
        {
            i += 1;
            let closed = false;
            while (i < text.length)
            {
                if (text[i] === '\\')
                {
                    i += 2;
                    continue;
                }
                if (text[i] === '"')
                {
                    i += 1;
                    closed = true;
                    break;
                }
                i += 1;
            }
            if (!closed)
            {
                return true;
            }
            continue;
        }
        i += 1;
    }
    return false;
}

// A `catch (e)` binding whose last remaining use was a log line.  The binding
// goes and the clause is left as `catch { }`, which std itself writes when it
// does not need the error (fillet.fs: "catch {} // Do not throw an error to
// allow the server side to execute the feature").  Without this, Feature Studio
// reports "Variable revolveError set but not used" on every such catch.
function collectUnusedCatchEdits(source, mask, original, originalMask) {
    const edits = [];
    let from = 0;

    for (;;)
    {
        const found = findCode(source, mask, /\bcatch\s*\(/g, from);
        if (found === null)
        {
            break;
        }
        const parenIndex = found.index + found[0].lastIndexOf('(');
        const close = matchBracket(source, mask, parenIndex);
        if (close < 0)
        {
            fail(`line ${lineOf(source, parenIndex)}: unbalanced parentheses in a catch clause`);
        }
        from = close + 1;

        const name = codeText(source, mask, parenIndex + 1, close).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        {
            continue; // not a plain binding
        }
        if (countWord(source, mask, name) !== 1)
        {
            continue; // still read somewhere
        }
        if (countWord(original, originalMask, name) < 2)
        {
            continue; // already unused in the source: not ours to delete
        }

        edits.push({
            start: parenIndex,
            end: close + 1,
            text: '',
            keepLine: true, // `catch` keeps its own line; the brace is on the next
            note: `unused catch binding ${name} (now catch { })`,
        });
    }

    return edits;
}

// Index of the `;` ending the statement at `start`, tracking bracket depth, so
// a `{ ... }` initialiser does not look like the end of the statement.
function endOfSimpleStatement(source, mask, start) {
    let depth = 0;
    for (let i = start; i < source.length; i += 1)
    {
        if (!isCode(mask, i))
        {
            continue;
        }
        const ch = source[i];
        if (ch === '(' || ch === '[' || ch === '{')
        {
            depth += 1;
        }
        else if (ch === ')' || ch === ']' || ch === '}')
        {
            if (depth === 0)
            {
                return -1; // the statement ran into an enclosing block
            }
            depth -= 1;
        }
        else if (ch === ';' && depth === 0)
        {
            return i;
        }
    }
    return -1;
}


// A statement inside a branch that is already going away must not be recorded
// as well: keeping the widest edit and dropping the ones inside it is what
// makes overlapping edits impossible.
function dropNested(edits) {
    const kept = [];
    for (const edit of [...edits].sort((a, b) => (b.end - b.start) - (a.end - a.start)))
    {
        if (kept.some((outer) => edit.start >= outer.start && edit.end <= outer.end))
        {
            continue;
        }
        kept.push(edit);
    }
    return kept;
}

// An `if` block the removals emptied out.  A no-op either way, but leaving one
// behind is confusing to read, and it is a sign the debug code used to be
// there.  Only reached after a pass that removed something, so an `if` that was
// already empty in the source is never touched.
function collectEmptyBlockEdits(source, mask) {
    const edits = [];
    let from = 0;

    for (;;)
    {
        const found = findCode(source, mask, /\bif\s*\(/g, from);
        if (found === null)
        {
            break;
        }
        const parenIndex = found.index + found[0].lastIndexOf('(');
        const close = matchBracket(source, mask, parenIndex);
        if (close < 0)
        {
            fail(`line ${lineOf(source, parenIndex)}: unbalanced parentheses in an if condition`);
        }
        const bodyStart = skipSpace(source, mask, close + 1);
        if (source[bodyStart] !== '{')
        {
            from = close + 1;
            continue;
        }
        const bodyEnd = matchBracket(source, mask, bodyStart);
        if (bodyEnd < 0)
        {
            fail(`line ${lineOf(source, found.index)}: unbalanced braces in an if body`);
        }
        from = bodyEnd + 1;

        if (codeText(source, mask, bodyStart + 1, bodyEnd).trim() !== '')
        {
            continue; // still does something
        }
        if (elseFollows(source, mask, bodyEnd + 1))
        {
            continue; // removing it would leave the `else` with nothing to attach to
        }
        edits.push({
            start: expandToLineStart(source, triviaStart(source, found.index)),
            end: bodyEnd + 1,
            text: '',
            note: 'if block left empty by the removals',
        });
    }

    return edits;
}

// A literal initialiser only.  Anything that could evaluate something (a call, a
// query, a map built from a function) is left alone: dropping it could change
// behaviour, and an unused local is a far smaller problem than that.
const LITERAL_INIT = /^(?:true|false|undefined|-?\d+(?:\.\d+)?(?:e-?\d+)?|0x[0-9a-fA-F]+|"[^"]*"|'[^']*'|\[\]|\{\})$/;

function parenDepth(source, mask, index) {
    let depth = 0;
    for (let i = 0; i < index; i += 1)
    {
        if (!isCode(mask, i))
        {
            continue;
        }
        if (source[i] === '(')
        {
            depth += 1;
        }
        else if (source[i] === ')')
        {
            depth -= 1;
        }
    }
    return depth;
}

// A local the log lines were the only readers of: assigned, never read.  Those
// are exactly the ones Feature Studio flags as "set but not used" once the
// printlns are gone (`revolveFailed` is the case in point).  The declaration and
// every assignment to it go; anything read anywhere, or already write-only in
// the source, is left for a human.
function collectWriteOnlyLocalEdits(source, mask, original, originalMask) {
    const edits = [];

    for (let from = 0; ; )
    {
        const decl = findCode(source, mask, /\b(?:var|const)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g, from);
        if (decl === null)
        {
            break;
        }
        const name = /\b(?:var|const)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(decl[0])[1];
        const semi = endOfSimpleStatement(source, mask, decl.index);
        if (semi < 0)
        {
            from = decl.index + decl[0].length;
            continue;
        }
        from = semi + 1;

        if (parenDepth(source, mask, decl.index) !== 0)
        {
            continue; // a `for` header or an argument list, not a statement
        }
        const init = codeText(source, mask, decl.index + decl[0].length, semi).trim();
        if (!LITERAL_INIT.test(init))
        {
            continue;
        }

        // Every remaining mention has to be an assignment, or it is a read.
        const total = countWord(source, mask, name);
        const writes = [];
        for (let at = semi + 1; ; )
        {
            const write = findCode(source, mask,
                new RegExp(`(?<![\\w.$])${name}\\s*(?:[-+*/%|&^]?=)(?![=])`, 'g'), at);
            if (write === null)
            {
                break;
            }
            at = write.index + write[0].length;
            const prev = prevCodeIndex(source, mask, write.index);
            if (prev < 0 || !'{;}'.includes(source[prev]))
            {
                continue; // not a statement of its own
            }
            const end = endOfSimpleStatement(source, mask, write.index);
            if (end < 0)
            {
                continue;
            }
            writes.push({ start: write.index, end: end + 1 });
        }

        if (total !== 1 + writes.length)
        {
            continue; // read somewhere: a real variable
        }
        if (countWord(original, originalMask, name) <= total)
        {
            continue; // already write-only in the source: not ours to delete
        }

        edits.push({
            start: expandToLineStart(source, triviaStart(source, decl.index)),
            end: semi + 1,
            text: '',
            note: `write-only local ${name} (declared, assigned, never read)`,
        });
        for (const write of writes)
        {
            edits.push({
                start: expandToLineStart(source, write.start),
                end: write.end,
                text: '',
                note: `assignment to ${name}`,
            });
        }
    }

    return edits;
}

// Phase one: the debug statements themselves, per file, to a fixpoint.
function stripDebug(source) {
    let text = source;
    const notes = [];
    const originalMask = maskSource(source);

    for (let pass = 0; pass < 20; pass += 1)
    {
        const mask = maskSource(text);
        const edits = dropNested([
            ...collectFlagEdits(text, mask),
            ...collectDebugBranchEdits(text, mask),
            ...collectPrintlnEdits(text, mask),
            ...(notes.length > 0 ? collectEmptyBlockEdits(text, mask) : []),
            // A catch binding and a write-only local only become unused once the
            // printlns that read them are gone, so these run on the second pass
            // onwards -- never on a file nothing has been removed from yet.
            ...(notes.length > 0 ? collectUnusedCatchEdits(text, mask, source, originalMask) : []),
            ...(notes.length > 0 ? collectWriteOnlyLocalEdits(text, mask, source, originalMask) : []),
        ]);
        if (edits.length === 0)
        {
            break;
        }
        for (const edit of edits)
        {
            notes.push({ line: lineOf(text, edit.start), note: edit.note });
            if (!edit.keepLine)
            {
                // A removal that leaves the line empty takes the newline with
                // it; an in-line one (a catch binding) must not.
                edit.end = eatTrailingLine(text, edit.end);
            }
        }
        text = applyEdits(text, edits);
    }

    return { text, notes };
}


// Runs of blank lines left behind by the removals.  Trailing whitespace is NOT
// touched: the licence header carries it, and rewriting that is not this tool's
// business.
function tidy(text) {
    return text.replace(/\n{3,}/g, '\n\n');
}

// ------------------------------------------------------------------ main
//
// Written as a function that returns an exit code rather than calling
// process.exit: exiting straight after a write can truncate stdout when it is
// redirected to a file or a pipe.

// Relative to the repository when it is inside it, absolute when it is not.
function showPath(path) {
    const rel = relative(ROOT, path);
    return rel === '' || rel.startsWith('..') ? path : rel;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help)
    {
        process.stdout.write(usage());
        return 0;
    }

    // The mode decides whether the debug statements are stripped, so it has to
    // be settled before anything is read.  A flag on the command line wins over
    // the config, so CI can ask for a release build on a checkout with no
    // config; with neither, a dev build is the safe default, because it changes
    // no code.
    const config = loadConfig(options.config);
    const hasConfig = existsSync(options.config);
    const mode = options.mode ?? config.mode ?? 'dev';
    const release = mode === 'release';

    if (options.check && !release)
    {
        fail('--check only makes sense for a release build (--release, or "mode": "release")');
    }

    if (release && !hasConfig && !options.check)
    {
        process.stderr.write(`build-fs: no ${showPath(options.config)}.  Copy `
            + `${BUILD_CONFIG_EXAMPLE} to ${showPath(options.config)} and fill it in,\n`
            + 'or pass --config FILE.  A release build cannot be written without it.\n');
        return 1;
    }

    const sources = options.files.length > 0
        ? options.files
        : readdirSync(SRC_DIR).filter((f) => f.endsWith('.fs')).sort().map((f) => join('osFeature', f));

    if (sources.length === 0)
    {
        fail(`no .fs sources found in ${relative(ROOT, SRC_DIR) || SRC_DIR}`);
    }

    // A dev build written into dist/featurescript/release is the worst failure
    // this tool can have: nothing is stripped, it still logs, and it sits where
    // a reader assumes it is ready to paste into Feature Studio.
    const outDir = options.out ?? join(ROOT, 'dist', 'featurescript', mode);

    if (!release && outDir.endsWith(`${sep}release`))
    {
        process.stderr.write(`build-fs: refusing to write a dev build to ${showPath(outDir)}.\n`
            + 'A file with its debug statements still in it must not sit in the release\n'
            + 'folder.  Use --release, or --out to write somewhere else.\n');
        return 1;
    }
    const docs = [];
    const removedNames = [];
    let failed = false;

    for (const rel of sources)
    {
        const name = rel.split('/').pop();
        const source = readFileSync(join(ROOT, rel), 'utf8');
        docs.push({ rel, name, source, text: source, notes: [] });
    }

    if (release)
    {
        // Phase one, per file: the debug statements.
        for (const doc of docs)
        {
            try
            {
                const stripped = stripDebug(doc.source);
                doc.text = stripped.text;
                doc.notes = stripped.notes;
            }
            catch (error)
            {
                process.stderr.write(`build-fs: ${doc.rel}: ${error.message}\n`);
                failed = true;
                doc.text = doc.source;
            }
        }

        // Phase two, across the whole set: the helpers phase one orphaned.
        if (options.deadcode && !failed)
        {
            try
            {
                removedNames.push(...removeOrphans(docs));
            }
            catch (error)
            {
                process.stderr.write(`build-fs: ${error.message}\n`);
                failed = true;
            }
        }

        for (const doc of docs)
        {
            doc.text = insertBanner(doc.text, banner('release', doc.name));
            doc.notes.sort((a, b) => a.line - b.line);
        }
    }
    else
    {
        for (const doc of docs)
        {
            doc.text = insertBanner(doc.source, banner('dev', doc.name));
        }
    }

    // The document ids go in last, so neither the strip nor the banner can ever
    // be the thing that has to recognise a namespaced or blank import.
    //
    // Only a build that WRITES needs the ids: a file pasted into Feature Studio
    // with `path : ""` imports nothing.  A `--check` run does not, because CI has
    // a fresh checkout and no config, and the ids are untracked by design.  It
    // still checks everything about them that does not need the config -- a
    // hard-coded id, a missing tag -- so the regression this mechanism exists to
    // prevent is still caught there.
    const strict = release && hasConfig;
    const usedKeys = new Set();
    for (const doc of docs)
    {
        try
        {
            const filled = fillImports(doc.text, config.imports, doc.name, strict,
                showPath(options.config));
            doc.text = filled.text;
            for (const key of filled.used)
            {
                usedKeys.add(key);
            }
        }
        catch (error)
        {
            process.stderr.write(`build-fs: ${error.message}\n`);
            return 1;
        }
    }

    const unusedKeys = Object.keys(config.imports).filter((key) => !usedKeys.has(key));
    if (unusedKeys.length > 0)
    {
        process.stdout.write(`note: ${showPath(options.config)} has `
            + `${unusedKeys.length} import key(s) no document asks for: ${unusedKeys.join(', ')}\n`);
    }
    else if (!hasConfig)
    {
        process.stdout.write(`note: no ${showPath(options.config)}; the document ids are `
            + 'left blank, so this build is not pasteable into Feature Studio\n');
    }

    if (release)
    {
        for (const doc of docs)
        {
            doc.problems = validate(doc.name, doc.text, removedNames);
            if (doc.problems.length > 0)
            {
                failed = true;
            }
        }
    }
    else
    {
        for (const doc of docs)
        {
            doc.problems = [];
        }
    }

    const sourceLines = docs.reduce((sum, d) => sum + d.source.split('\n').length, 0);
    const outputLines = docs.reduce((sum, d) => sum + d.text.split('\n').length, 0);
    const removed = docs.reduce((sum, d) => sum + d.notes.length, 0);

    for (const doc of docs)
    {
        process.stdout.write(`${doc.problems.length > 0 ? 'FAIL' : 'ok  '}  ${doc.rel}\n`);
        if (release)
        {
            for (const note of doc.notes)
            {
                process.stdout.write(`        - ${note.line}: ${note.note}\n`);
            }
            for (const problem of doc.problems)
            {
                process.stdout.write(`        ! ${problem}\n`);
            }
        }
    }

    if (failed)
    {
        process.stderr.write('\nbuild-fs: the release build did not pass validation; nothing was written.\n');
        return 1;
    }

    if (options.check)
    {
        process.stdout.write(`\nrelease build validated: ${removed} debug construct`
            + `${removed === 1 ? '' : 's'} stripped, ${sourceLines} -> ${outputLines} lines. `
            + 'Nothing written (--check).\n');
        return 0;
    }

    rmSync(outDir, { recursive: true, force: true });
    for (const doc of docs)
    {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, doc.name), tidy(doc.text));
    }

    process.stdout.write(`\n${mode} build -> ${showPath(outDir)}: `
        + `${docs.length} file${docs.length === 1 ? '' : 's'}, ${sourceLines} -> ${outputLines} lines`
        + (release ? `, ${removed} debug constructs stripped` : '') + '\n');

    return 0;
}

// Imported by the tests: the transform runs only when this file is the entry
// point, so importing it has no side effects.
export {
    BUILD_CONFIG,
    BUILD_CONFIG_EXAMPLE,
    BuildError,
    MODES,
    banner,
    fillImports,
    insertBanner,
    loadConfig,
    main,
    maskSource,
    removeOrphans,
    stripDebug,
    tidy,
    validate,
};

const isEntryPoint = process.argv[1] !== undefined
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint)
{
    try
    {
        process.exitCode = main();
    }
    catch (error)
    {
        process.stderr.write(`build-fs: ${error instanceof BuildError ? error.message : error.stack}\n`);
        process.exitCode = 1;
    }
}
