/**
 * Tests for the release build.  Run with:  node --test tools/
 *
 * The point of these is the awkward cases: an else-chain, a debug branch with
 * no braces, a flag used backwards, a helper that is only called from a debug
 * branch in ANOTHER file.  Each one either has to come out right or has to be a
 * hard error -- silently wrong output is the one outcome not allowed.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { removeOrphans, stripDebug, validate } from './build-fs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEADER = 'FeatureScript 3044;\nimport(path : "onshape/std/common.fs", version : "3044.0");\n\n';
// Same, but with no blank line after the imports, for fixtures that put a note
// directly above the declaration it is about.
const HEADER_TIGHT = 'FeatureScript 3044;\nimport(path : "onshape/std/common.fs", version : "3044.0");\n';

function release(...sources) {
    const docs = sources.map((source) => ({ source, text: source, notes: [] }));
    for (const doc of docs)
    {
        const stripped = stripDebug(doc.source);
        doc.text = stripped.text;
        doc.notes = stripped.notes;
    }
    return { docs, removedNames: removeOrphans(docs) };
}

function releaseOne(source) {
    return release(source).docs[0].text;
}

test('drops the debug flag and the branch it guards', () => {
    const out = releaseOne([
        HEADER_TIGHT,
        '// TEMPORARY: chatter.',
        'const DEBUG_X = true;',
        '',
        'function f(a)',
        '{',
        '    if (DEBUG_X)',
        '    {',
        '        println("hi " ~ toString(a));',
        '    }',
        '    return a + 1;',
        '}',
    ].join('\n'));

    assert.ok(!out.includes('DEBUG_X'), 'flag is gone');
    assert.ok(!out.includes('println'), 'println is gone');
    assert.ok(!out.includes('TEMPORARY'), 'its note is gone');
    assert.ok(out.includes('return a + 1;'), 'the real work survives');
});

test('keeps the else branch of `if (DEBUG) { log } else { work }`', () => {
    const out = releaseOne([
        HEADER,
        'const DEBUG_X = true;',
        'function f(a)',
        '{',
        '    if (DEBUG_X)',
        '    {',
        '        println("hi");',
        '    }',
        '    else',
        '    {',
        '        return a + 1;',
        '    }',
        '}',
    ].join('\n'));

    assert.ok(!out.includes('println'));
    assert.ok(out.includes('return a + 1;'), 'the else body survives');
    assert.ok(!out.includes('else'), 'the head, including `else`, is gone');
});

test('drops an `else if (DEBUG)` clause without leaving a dangling else', () => {
    const out = releaseOne([
        HEADER,
        'const DEBUG_X = true;',
        'function f(m)',
        '{',
        '    if (m == "a")',
        '    {',
        '        return 1;',
        '    }',
        '    else if (DEBUG_X)',
        '    {',
        '        println("unknown");',
        '    }',
        '    return 0;',
        '}',
    ].join('\n'));

    assert.ok(!out.includes('println'));
    assert.ok(!/\belse\b/.test(out), 'no `else` survives without an `if`');
    assert.equal(validate('f.fs', out, []).length, 0);
});

test('// @keep survives the sweep, a plain println does not', () => {
    const out = releaseOne([
        HEADER,
        'function f()',
        '{',
        '    // @keep: the user has to act on this.',
        '    println("actionable");',
        '    println("chatter");',
        '}',
    ].join('\n'));

    assert.ok(out.includes('actionable'), 'the kept line is still there');
    assert.ok(!out.includes('chatter'), 'the other one is not');
});

test('refuses a debug branch without braces', () => {
    assert.throws(
        () => releaseOne([HEADER, 'const DEBUG_X = true;', 'function f()', '{',
            '    if (DEBUG_X) return 1;', '}'].join('\n')),
        /braced body/);
});

test('a println inside a debug branch goes with the branch, not twice', () => {
    const out = releaseOne([
        HEADER,
        'const DEBUG_X = true;',
        'function f()',
        '{',
        '    if (DEBUG_X)',
        '    {',
        '        for (var i = 0; i < 3; i += 1)',
        '        {',
        '            println("i=" ~ toString(i));',
        '        }',
        '    }',
        '    return 1;',
        '}',
    ].join('\n'));

    assert.ok(!out.includes('println'));
    assert.ok(out.includes('return 1;'));
    assert.equal(validate('f.fs', out, []).length, 0);
});

test('a helper only a debug branch used is removed, chains and all', () => {
    const out = releaseOne([
        HEADER,
        'const DEBUG_X = true;',
        'function entry(c)',
        '{',
        '    if (DEBUG_X)',
        '    {',
        '        debugOnlyOuter(c);',
        '    }',
        '    return kept(c);',
        '}',
        'function debugOnlyOuter(c)',
        '{',
        '    println("outer");',
        '    return debugOnlyInner(c);',
        '}',
        'function debugOnlyInner(c)',
        '{',
        '    println("inner");',
        '    return c;',
        '}',
        'function kept(c)',
        '{',
        '    return c;',
        '}',
    ].join('\n'));

    assert.ok(out.includes('function entry'), 'the live entry point stays');
    assert.ok(out.includes('function kept'), 'and the helper it still calls');
    assert.ok(!out.includes('function debugOnlyOuter'), 'the debug-only helper goes');
    assert.ok(!out.includes('function debugOnlyInner'), 'and so does the one only it used');
});

test('an EXPORTED debug-only helper goes once its caller in another file drops it', () => {
    const { docs } = release(
        [
            HEADER,
            'const DEBUG_X = true;',
            'export function reportThing(c)',
            '{',
            '    if (DEBUG_X)',
            '    {',
            '        println("report " ~ toString(c));',
            '    }',
            '    return c;',
            '}',
        ].join('\n'),
        [
            HEADER,
            'const DEBUG_X = true;',
            'function use(c)',
            '{',
            '    if (DEBUG_X)',
            '    {',
            '        reportThing(c);',
            '    }',
            '    return c;',
            '}',
        ].join('\n'));

    assert.ok(!docs[0].text.includes('reportThing'), 'the helper is gone from its own file');
    assert.ok(docs[1].text.includes('function use'), 'the caller stays');
    assert.ok(!docs[1].text.includes('reportThing('), 'the debug call site is gone');
});

test('a helper the source never used is left alone', () => {
    const source = [HEADER, 'const DEBUG_X = true;', 'function f()', '{',
        '    if (DEBUG_X)', '    {', '        println("x");', '    }', '}',
        'function neverCalled()', '{', '    return 1;', '}'].join('\n');

    assert.ok(releaseOne(source).includes('function neverCalled'));
});

test('validate catches what the stripper should never leave behind', () => {
    assert.match(validate('x.fs', 'const DEBUG_X = true;\n', []).join('\n'), /debug flag .* survived/);
    assert.match(validate('x.fs', 'function f() {\n', []).join('\n'), /unbalanced/);
    assert.match(
        validate('x.fs', 'function f()\n{\n    println("x");\n    else\n    {\n        return 1;\n    }\n}\n', []).join('\n'),
        /no `if` in front/);
    assert.match(
        validate('x.fs', 'function f()\n{\n    gone();\n}\n', ['gone']).join('\n'),
        /still called/);
    assert.equal(validate('x.fs', 'function f()\n{\n    return 1;\n}\n', []).length, 0);
});

test('a catch binding only the log line read becomes a bare catch', () => {
    const out = releaseOne([
        HEADER,
        'function f(c)',
        '{',
        '    try',
        '    {',
        '        opRevolve(c);',
        '    }',
        '    catch(revolveError)',
        '    {',
        '        println("CAUGHT " ~ toString(revolveError));',
        '        return qCreatedBy("x");',
        '    }',
        '    return 1;',
        '}',
    ].join('\n'));

    assert.ok(!out.includes('revolveError'), 'the binding is gone');
    assert.ok(/catch\s*\n?\s*\{/.test(out), 'the clause is still a catch');
    assert.ok(out.includes('return qCreatedBy("x");'), 'the recovery path survives');
    assert.equal(validate('f.fs', out, []).length, 0);
});

test('a catch binding something still reads is left alone', () => {
    const out = releaseOne([
        HEADER,
        'function f(c)',
        '{',
        '    try',
        '    {',
        '        opRevolve(c);',
        '    }',
        '    catch(revolveError)',
        '    {',
        '        println("CAUGHT " ~ toString(revolveError));',
        '        return errorText(revolveError);',
        '    }',
        '    return 1;',
        '}',
    ].join('\n'));

    assert.ok(out.includes('catch(revolveError)'), 'still bound');
    assert.ok(out.includes('errorText(revolveError)'), 'and still read');
});

test('a local only the log line read goes, with its assignments', () => {
    const out = releaseOne([
        HEADER,
        'function f(c)',
        '{',
        '    var failed = false;',
        '    try',
        '    {',
        '        opRevolve(c);',
        '    }',
        '    catch(e)',
        '    {',
        '        failed = true;',
        '        println("CAUGHT " ~ toString(e) ~ (failed ? " THREW" : ""));',
        '    }',
        '    return count(c) != 0;',
        '}',
    ].join('\n'));

    assert.ok(!/\bfailed\b/.test(out), 'the write-only local is gone');
    assert.ok(out.includes('return count(c) != 0;'), 'the real work survives');
    assert.equal(validate('f.fs', out, []).length, 0);
});

test('a local that is read, or whose initialiser could evaluate, stays', () => {
    const readBack = releaseOne([
        HEADER,
        'function f(c)',
        '{',
        '    var flag = false;',
        '    if (DEBUG_X)',
        '    {',
        '        println("x");',
        '    }',
        '    return flag;',
        '}',
        'const DEBUG_X = true;',
    ].join('\n'));
    assert.ok(readBack.includes('var flag = false;'), 'a read local is real code');

    const withCall = releaseOne([
        HEADER,
        'function f(c)',
        '{',
        '    var found = findThing(c);',
        '    if (DEBUG_X)',
        '    {',
        '        println("x");',
        '    }',
        '    return 1;',
        '}',
        'const DEBUG_X = true;',
    ].join('\n'));
    assert.ok(withCall.includes('var found = findThing(c);'),
        'an initialiser with a call in it may have side effects, so it stays');
});

test('a write-only local the source already had is not ours to delete', () => {
    const source = [
        HEADER,
        'function f(c)',
        '{',
        '    var spare = 0;',
        '    spare = c;',
        '    if (DEBUG_X)',
        '    {',
        '        println("x");',
        '    }',
        '    return 1;',
        '}',
        'const DEBUG_X = true;',
    ].join('\n');

    assert.ok(releaseOne(source).includes('var spare = 0;'));
});

test('the real osFeature sources strip cleanly and validate', () => {
    const dir = join(ROOT, 'osFeature');
    const docs = readdirSync(dir).filter((f) => f.endsWith('.fs'))
        .sort()
        .map((f) => {
            const source = readFileSync(join(dir, f), 'utf8');
            return { name: f, source, text: source, notes: [] };
        });

    for (const doc of docs)
    {
        const stripped = stripDebug(doc.source);
        doc.text = stripped.text;
        doc.notes = stripped.notes;
    }
    const removedNames = removeOrphans(docs);

    for (const doc of docs)
    {
        assert.deepEqual(
            validate(doc.name, doc.text, removedNames), [],
            `${doc.name} should strip cleanly`);

        // The only printlns left are the ones a // @keep comment protected.
        const kept = (doc.source.match(/@keep/g) ?? []).length;
        const code = doc.text
            .split('\n')
            .filter((line) => !line.trim().startsWith('//'))
            .join('\n');
        const printed = (code.match(/(?<![\w.$])println\s*\(/g) ?? []).length;
        assert.equal(printed, kept, `${doc.name}: ${printed} printlns left, ${kept} @keep markers`);
    }

    // The warnings a user has to act on are the whole point of // @keep.
    const main = docs.find((d) => d.name === 'main.fs').text;
    assert.ok(main.includes('[schema] payload is'), 'the stale-payload warning survives');
    assert.ok(main.includes('has no motor mass set'), 'the motor-mass hint survives');
});
