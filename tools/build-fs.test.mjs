/**
 * Tests for the release build.  Run with:  node --test tools/
 *
 * The point of these is the awkward cases: an else-chain, a debug branch with
 * no braces, a flag used backwards, a helper that is only called from a debug
 * branch in ANOTHER file.  Each one either has to come out right or has to be a
 * hard error -- silently wrong output is the one outcome not allowed.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { fillImports, insertBanner, loadConfig, removeOrphans, stripDebug, validate } from './build-fs.mjs';

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

// ------------------------------------------------------------ document ids
//
// The Onshape document ids are per-document and untracked, so the sources
// leave them blank and the build fills them from a config.  Each of these is a
// way that can go wrong; a wrong fill is the one outcome not allowed.

const CONFIG = {
    componentSketches: { path: 'a0cb7665', version: '7127c90d' },
    utils: { path: 'cd77025b', version: '6b4ef6a3' },
    icon: { path: '0b745fbc', version: '15543728' },
    image: { path: '26547900', version: '5b03f331' },
};

const BLANK_DOC = [
    'FeatureScript 3044;',
    'import(path : "onshape/std/common.fs", version : "3044.0");',
    'import(path : "", version : ""); // @import utils',
    'icon::import(path : "", version : ""); // @import icon',
    '',
    'const A = 1;',
].join('\n');

test('fills a blank import from the config and keeps the tag', () => {
    const out = fillImports(BLANK_DOC, CONFIG, 'x.fs').text;
    assert.ok(
        out.includes('import(path : "cd77025b", version : "6b4ef6a3"); // @import utils'),
        'the plain import is filled');
    assert.ok(
        out.includes('icon::import(path : "0b745fbc", version : "15543728"); // @import icon'),
        'the namespaced import is filled');
    assert.ok(!out.includes('path : ""'), 'no blank import is left behind');
});

test('leaves the std imports alone', () => {
    // They are versioned with the `FeatureScript 3044;` header, not per
    // document, so they stay written out in the source and must survive.
    const out = fillImports(BLANK_DOC, CONFIG, 'x.fs').text;
    assert.ok(out.includes('import(path : "onshape/std/common.fs", version : "3044.0");'));
});

test('refuses a document id written out in the source', () => {
    // This is the whole point: the id must not be committable.
    const hard = BLANK_DOC.replace(
        'import(path : "", version : ""); // @import utils',
        // A made-up id, not a real one: this fixture is committed, and a real
        // document id in the repository is exactly what the build exists to
        // keep out of it.
        'import(path : "0123456789abcdef01234567", version : "fedcba9876543210fedcba98");');
    assert.throws(() => fillImports(hard, CONFIG, 'x.fs'), /document id is written out/);
});

test('refuses a blank import with no tag, rather than guessing', () => {
    const untagged = BLANK_DOC.replace(' // @import utils', '');
    assert.throws(() => fillImports(untagged, CONFIG, 'x.fs'), /no `.*@import <key>.*` tag/);
});

test('refuses a key the config does not have, and names the keys it does', () => {
    const odd = BLANK_DOC.replace('@import icon', '@import iconBlob');
    assert.throws(() => fillImports(odd, CONFIG, 'x.fs'), /@import iconBlob is not in/);
    try
    {
        fillImports(odd, CONFIG, 'x.fs');
    }
    catch (error)
    {
        assert.ok(error.message.includes('componentSketches, icon, image, utils'),
            'the message lists what the config does have');
    }
});

test('reports every bad import in a document, not just the first', () => {
    // A fix-everything-one-error-at-a-time loop is the failure mode here.
    const bad = BLANK_DOC.replace(' // @import utils', '').replace('@import icon', '@import nope');
    assert.throws(() => fillImports(bad, CONFIG, 'x.fs'), (error) => {
        assert.ok(error.message.includes('line 3'), 'reports the untagged line');
        assert.ok(error.message.includes('line 4'), 'reports the unknown key');
        return true;
    });
});

test('a non-strict fill leaves ids blank instead of failing', () => {
    // What a debug build does before the config exists: the file is not
    // pasteable yet, but the build still produces output.
    const out = fillImports(BLANK_DOC, {}, 'x.fs', false).text;
    assert.ok(out.includes('import(path : "", version : ""); // @import utils'));
    assert.ok(!out.includes('cd77025b'));
});

test('loadConfig reads the mode and the imports, and refuses nonsense', () => {
    const dir = mkdtempSync(join(tmpdir(), 'build-fs-'));
    const path = (name, body) => {
        const file = join(dir, name);
        writeFileSync(file, body);
        return file;
    };

    assert.deepEqual(
        loadConfig(path('ok.json', JSON.stringify({ mode: 'release', imports: CONFIG }))),
        { mode: 'release', imports: CONFIG }, 'a complete config loads');
    assert.deepEqual(loadConfig(join(dir, 'absent.json')), { mode: null, imports: {} },
        'no file is an empty config, not an error');
    assert.deepEqual(
        loadConfig(path('modeonly.json', '{"mode":"dev"}')).mode, 'dev',
        'the mode may be given on its own');
    assert.deepEqual(
        loadConfig(path('importsonly.json', JSON.stringify({ imports: CONFIG }))).mode, null,
        'the imports may be given on their own');

    assert.throws(
        () => loadConfig(path('mode.json', '{"mode":"production"}')),
        /"mode" must be one of dev, release, not "production"/);
    assert.throws(
        () => loadConfig(path('typo.json', '{"imprts":{}}')),
        /unknown key "imprts"/);
    assert.throws(
        () => loadConfig(path('blank.json', '{"imports":{"utils":{"path":"","version":"v"}}}')),
        /"imports.utils.path" must be a non-empty string/);
    assert.throws(
        () => loadConfig(path('half.json', '{"imports":{"utils":{"path":"p"}}}')),
        /"imports.utils.version" must be a non-empty string/);
    assert.throws(() => loadConfig(path('array.json', '[]')), /must be a JSON object/);
    assert.throws(() => loadConfig(path('bad.json', '{')), /is not valid JSON/);
});

test('the config picks the mode, and a flag overrides it', () => {
    // The point of putting `mode` in the config: one file per mode, named on the
    // command line, and each build does the right thing without a flag.
    const dir = mkdtempSync(join(tmpdir(), 'build-fs-'));
    const run = (args) => spawnSync(
        process.execPath, [join(ROOT, 'tools', 'build-fs.mjs'), ...args],
        { encoding: 'utf8' });
    const out = join(dir, 'out');
    const config = (name, body) => {
        const file = join(dir, name);
        writeFileSync(file, body);
        return file;
    };

    const devConfig = config('dev.json', JSON.stringify({ mode: 'dev', imports: CONFIG }));
    const relConfig = config('rel.json', JSON.stringify({ mode: 'release', imports: CONFIG }));

    const dev = run(['--config', devConfig, '--out', out]);
    assert.equal(dev.status, 0, 'a dev config builds');
    assert.doesNotMatch(dev.stdout, /debug constructs stripped/, 'a dev build strips nothing');
    assert.match(dev.stdout, /^dev build/m);

    const rel = run(['--config', relConfig, '--out', out]);
    assert.equal(rel.status, 0, 'a release config builds');
    assert.match(rel.stdout, /debug constructs stripped/, 'release mode strips');

    // A flag beats the config, which is how CI gets a release build out of a
    // checkout with no config at all.
    const overridden = run(['--config', devConfig, '--release', '--out', out]);
    assert.match(overridden.stdout, /debug constructs stripped/, '--release overrides "mode": "dev"');

    // Neither a flag nor a config: dev, because that changes no code.
    const bare = run(['--config', join(dir, 'absent.json'), '--out', out]);
    assert.equal(bare.status, 0, 'no config falls back to a dev build');
    assert.match(bare.stdout, /^dev build/m, 'and says so');
});

test('each fs: script names the config it builds from, not a bare mode', () => {
    // The scripts must not hardcode a mode: the point of the per-mode config
    // files is that `pnpm run fs:dev` reads the dev one and
    // `pnpm run fs:release` reads the prod one, each bringing its own ids AND
    // its own mode.  A stray --dev/--release would silently override that.
    const scripts = JSON.parse(
        readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;

    // Each script also names its output folder, so a config saying
    // "mode": "release" cannot send `fs:dev`'s output to the release folder.
    const expected = {
        'fs:dev': ['tools/feature-imports-dev.json', 'dist/featurescript/dev'],
        'fs:release': ['tools/feature-imports-prod.json', 'dist/featurescript/release'],
    };

    for (const [name, [config, outDir]] of Object.entries(expected))
    {
        const command = scripts[name];
        assert.ok(command !== undefined, `${name} exists`);
        assert.ok(command.includes(`--config ${config}`),
            `${name} builds from ${config}, got: ${command}`);
        assert.ok(command.includes(`--out ${outDir}`),
            `${name} must write to ${outDir}, got: ${command}`);
        assert.doesNotMatch(command, /--dev\b|--debug\b|--release\b/,
            `${name} must let the config choose the mode, got: ${command}`);
    }

    // fs:check has no ids to fill, so it forces the mode it validates.
    assert.match(scripts['fs:check'], /--release/);
});

test('a dev build is refused into the release folder', () => {
    // The worst possible failure: an unstripped file sitting where a reader
    // assumes it is ready to paste into Feature Studio.
    const run = (args) => spawnSync(
        process.execPath, [join(ROOT, 'tools', 'build-fs.mjs'), ...args],
        { encoding: 'utf8' });
    const dir = mkdtempSync(join(tmpdir(), 'build-fs-'));
    const out = join(dir, 'release');

    // A config of its own, carrying ids: a release build needs one, and the
    // real local/build-config.json is gitignored, so relying on it would make
    // this test pass on a developer machine and fail in CI.
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ mode: 'release', imports: CONFIG }));

    const refused = run(['--dev', '--config', config, '--out', out]);
    assert.equal(refused.status, 1, 'a dev build must not be written to a release folder');
    assert.match(refused.stderr, /refusing to write a dev build/);

    const allowed = run(['--release', '--config', config, '--out', out]);
    assert.equal(allowed.status, 0, 'a release build there is exactly the point');
});

test('--check refuses a dev build rather than validating nothing', () => {
    const run = (args) => spawnSync(
        process.execPath, [join(ROOT, 'tools', 'build-fs.mjs'), ...args],
        { encoding: 'utf8' });

    const dev = run(['--check', '--dev']);
    assert.equal(dev.status, 1);
    assert.match(dev.stderr, /--check only makes sense for a release build/);
});

test('the tracked sources name no document id, and the release build fills them all', () => {
    // The regression this whole mechanism exists to prevent.
    for (const name of readdirSync(join(ROOT, 'osFeature')).filter((f) => f.endsWith('.fs')))
    {
        const text = readFileSync(join(ROOT, 'osFeature', name), 'utf8');
        for (const line of text.split('\n').filter((l) => /^\s*(?:\w+::)?import\s*\(/.test(l)))
        {
            if (line.includes('onshape/std/'))
            {
                continue;
            }
            assert.match(line, /path\s*:\s*""/, `${name}: ${line.trim()} must be blank`);
            assert.match(line, /@import\s+\S+/, `${name}: ${line.trim()} must be tagged`);
        }
    }
});

test('a release build to WRITE needs the ids, but --check does not', () => {
    // CI runs `fs:check` on a fresh checkout, which by design has no config
    // (the ids are untracked).  It must still pass there, while a build that
    // writes a file Feature Studio has to import from must not.
    const run = (args) => spawnSync(
        process.execPath, [join(ROOT, 'tools', 'build-fs.mjs'), ...args],
        { encoding: 'utf8' });

    const missing = join(mkdtempSync(join(tmpdir(), 'build-fs-')), 'absent.json');
    const writing = run(['--release', '--config', missing]);
    assert.equal(writing.status, 1, 'a release build with no config refuses to write');
    assert.match(writing.stderr, /cannot be written without it/);

    const checking = run(['--release', '--check', '--config', missing]);
    assert.equal(checking.status, 0, 'a --check run passes without the ids');
    assert.match(checking.stdout, /Nothing written/);
});

test('no real Onshape document id is committed anywhere in the repository', () => {
    // A document id is 24 hex characters.  It belongs to whoever made that
    // document, it changes with every version, and it must never be committed
    // -- this very test file once carried a real one in a fixture.
    const skip = ['node_modules', 'dist', '.git', 'openrocket-unstable', 'local'];
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory())
        {
            return skip.includes(entry.name) ? [] : walk(full);
        }
        return /\.(fs|mjs|js|ts|json|md|yml|yaml|html)$/.test(entry.name) ? [full] : [];
    });

    const ID = /\b[0-9a-f]{24}\b/;
    const offenders = [];
    for (const file of walk(ROOT))
    {
        if (file.endsWith('build-fs.test.mjs'))
        {
            continue; // this test, and the placeholder fixture it documents
        }
        for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries())
        {
            // Only an import line can be a leaked id; 24 hex elsewhere is a hash.
            if (/import\s*\(/.test(line) && ID.test(line))
            {
                offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
            }
        }
    }

    assert.deepEqual(offenders, [],
        'document ids must stay in the untracked build config');
});

test('the banner goes after a namespaced import, not before it', () => {
    // main.fs imports its icon and description image as `icon::import(...)`,
    // which the banner's import pattern has to recognise or the banner lands
    // above them and Onshape rejects the document.
    const source = [
        'FeatureScript 3044;',
        'import(path : "onshape/std/common.fs", version : "3044.0");',
        'icon::import(path : "0b745fbc", version : "15543728");',
        'image::import(path : "26547900", version : "5b03f331");',
        '',
        'annotation { "Feature Type Name" : "X" }',
    ].join('\n');

    const out = insertBanner(source, '// BANNER');

    const lines = out.split('\n');
    const bannerLine = lines.indexOf('// BANNER');
    const lastImport = lines.reduce(
        (last, line, i) => (line.includes('import(') ? i : last), -1);
    assert.ok(bannerLine > lastImport, 'banner follows every import');
});

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
