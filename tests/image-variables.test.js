// Image variables (image, imageList, imageMap): the pure rules, validation, storage
// and rotation, and expression lookups. UI is in image-variables-ui.test.js, the
// API / prompted / World Info restrictions in api/image-variables-api.test.js.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import context from './harness/context.js';
import settings from './harness/settings.js';
import {
    IMAGE_TYPES, isImageType, checkImageValue, emptyImageValue, sanitizeImageValue,
    resolveKeyString, resolveMapImage, activeImageRef, safeImageSrc,
} from '../src/core/image-variables.js';
import { blankDefinition, getDefaultValue } from '../src/core/variable-schema.js';
import { validateValueStrict, coerceValue } from '../src/core/variable-validation.js';
import { evaluateExpression, extractIdentifiers } from '../src/core/expression-dsl.js';

// The harness swaps chat-state for a mock; storage rules live in the REAL module.
const realChatState = await vi.importActual('../src/core/chat-state.js');

const def = (type, extra = {}) => ({ ...blankDefinition(), id: `v-${type}`, name: `se__${type}`, type, defaultValue: emptyImageValue(type), ...extra });

describe('the three types', () => {
    it('are image, imageList and imageMap', () => {
        expect([...IMAGE_TYPES]).toEqual(['image', 'imageList', 'imageMap']);
        expect(isImageType('image') && isImageType('imageList') && isImageType('imageMap')).toBe(true);
        expect(isImageType({ type: 'imageMap' })).toBe(true);
        for (const other of ['string', 'array', 'number', 'calculated', 'datetime', undefined, null]) expect(isImageType(other)).toBe(false);
    });

    it('blank definitions gain currentKeyVariable, empty by default', () => {
        expect(blankDefinition().currentKeyVariable).toBe('');
    });
});

describe('validation: strict types, no fetching', () => {
    it('image must be a string', () => {
        expect(checkImageValue('image', 'https://x/y.png')).toEqual({ ok: true, value: 'https://x/y.png' });
        expect(checkImageValue('image', '')).toEqual({ ok: true, value: '' });
        for (const bad of [5, true, null, undefined, [], {}, ['a']]) expect(checkImageValue('image', bad).ok, String(bad)).toBe(false);
    });

    it('imageList must be an array of strings (a JSON string is parsed)', () => {
        expect(checkImageValue('imageList', ['a', 'b'])).toEqual({ ok: true, value: ['a', 'b'] });
        expect(checkImageValue('imageList', '["a","b"]')).toEqual({ ok: true, value: ['a', 'b'] });
        expect(checkImageValue('imageList', [])).toEqual({ ok: true, value: [] });
        for (const bad of [['a', 1], ['a', null], 'nope', 5, {}, { 0: 'a' }, null]) expect(checkImageValue('imageList', bad).ok, JSON.stringify(bad)).toBe(false);
        expect(checkImageValue('imageList', ['a', 2]).error).toMatch(/item 1/);
    });

    it('imageMap must be an object whose values are strings (a JSON string is parsed)', () => {
        expect(checkImageValue('imageMap', { happy: 'h.png' })).toEqual({ ok: true, value: { happy: 'h.png' } });
        expect(checkImageValue('imageMap', '{"a":"1"}')).toEqual({ ok: true, value: { a: '1' } });
        expect(checkImageValue('imageMap', {})).toEqual({ ok: true, value: {} });
        for (const bad of [{ a: 1 }, { a: null }, { a: ['x'] }, ['a'], 'nope', 5, null]) expect(checkImageValue('imageMap', bad).ok, JSON.stringify(bad)).toBe(false);
        expect(checkImageValue('imageMap', { a: 'x', b: 2 }).error).toMatch(/"b"/);
    });

    it('a result is a copy, and nothing is coerced or fetched', () => {
        const source = ['a'];
        const { value } = checkImageValue('imageList', source);
        value.push('b');
        expect(source).toEqual(['a']);
        expect(checkImageValue('image', 5).ok).toBe(false); // a number is not turned into a string
        expect(checkImageValue('nope', 'x').ok).toBe(false);
    });

    it('validateValueStrict / coerceValue use the same rules and fall back to the empty default', () => {
        expect(validateValueStrict(def('image'), 'a.png')).toMatchObject({ valid: true, value: 'a.png' });
        expect(validateValueStrict(def('image'), 5)).toMatchObject({ valid: false, value: '' });
        expect(validateValueStrict(def('imageList'), ['a'])).toMatchObject({ valid: true, value: ['a'] });
        expect(validateValueStrict(def('imageList'), ['a', 1])).toMatchObject({ valid: false, value: [] });
        expect(validateValueStrict(def('imageMap'), { k: 'v' })).toMatchObject({ valid: true, value: { k: 'v' } });
        expect(validateValueStrict(def('imageMap'), { k: 1 })).toMatchObject({ valid: false, value: {} });
        expect(validateValueStrict(def('imageMap'), null)).toMatchObject({ valid: true, value: {} });

        expect(coerceValue(def('image'), 'x.png')).toBe('x.png');
        expect(coerceValue(def('image'), 7)).toBe('');
        expect(coerceValue(def('imageList'), '["a"]')).toEqual(['a']);
        expect(coerceValue(def('imageList'), 'not json')).toEqual([]);
        expect(coerceValue(def('imageMap'), '{"a":"b"}')).toEqual({ a: 'b' });
        expect(coerceValue(def('imageMap'), [1])).toEqual({});
    });

    it('getDefaultValue: empty unless the definition carries a valid default', () => {
        expect(getDefaultValue(def('image'))).toBe('');
        expect(getDefaultValue(def('image', { defaultValue: 'a.png' }))).toBe('a.png');
        expect(getDefaultValue(def('image', { defaultValue: 0 }))).toBe('');
        expect(getDefaultValue(def('imageList'))).toEqual([]);
        expect(getDefaultValue(def('imageList', { defaultValue: '["a","b"]' }))).toEqual(['a', 'b']);
        expect(getDefaultValue(def('imageList', { defaultValue: [1] }))).toEqual([]);
        expect(getDefaultValue(def('imageMap'))).toEqual({});
        expect(getDefaultValue(def('imageMap', { defaultValue: '{"k":"v"}' }))).toEqual({ k: 'v' });
        expect(getDefaultValue(def('imageMap', { defaultValue: { k: 2 } }))).toEqual({});
    });

    it('defaults are fresh copies (editing one chat\'s value cannot change the definition)', () => {
        const d = def('imageList', { defaultValue: ['a'] });
        getDefaultValue(d).push('b');
        expect(d.defaultValue).toEqual(['a']);
    });
});

describe('serialization: presets round-trip through JSON', () => {
    it('all three types survive JSON.stringify/parse unchanged', () => {
        const defs = [def('image', { defaultValue: 'a.png' }), def('imageList', { defaultValue: ['a', 'b'] }), def('imageMap', { defaultValue: { k: 'v' }, currentKeyVariable: 'se__mood' })];
        expect(JSON.parse(JSON.stringify(defs))).toEqual(defs);
    });
});

describe('sanitizing what is stored (setVar)', () => {
    it('keeps only strings: one bad item does not wipe the list', () => {
        expect(sanitizeImageValue('image', 'a')).toBe('a');
        expect(sanitizeImageValue('image', 5)).toBe('');
        expect(sanitizeImageValue('imageList', ['a', 1, null, 'b'])).toEqual(['a', 'b']);
        expect(sanitizeImageValue('imageList', 'x')).toEqual([]);
        expect(sanitizeImageValue('imageList', '["a",2]')).toEqual(['a']);
        expect(sanitizeImageValue('imageMap', { a: 'x', b: 2, c: null })).toEqual({ a: 'x' });
        expect(sanitizeImageValue('imageMap', ['x'])).toEqual({});
        expect(sanitizeImageValue('imageMap', '{"a":"1","b":2}')).toEqual({ a: '1' });
    });

    describe('the real setVar', () => {
        beforeEach(() => settings.reset());

        it('stores each type as a string / array of strings / object of strings', () => {
            realChatState.setVar('chat-1', 'se__image', 'a.png', def('image'));
            realChatState.setVar('chat-1', 'se__imageList', ['a', 5, 'b'], def('imageList'));
            realChatState.setVar('chat-1', 'se__imageMap', { k: 'v', bad: 7 }, def('imageMap'));
            expect(realChatState.getVar('chat-1', 'se__image').value).toBe('a.png');
            expect(realChatState.getVar('chat-1', 'se__imageList').value).toEqual(['a', 'b']);
            expect(realChatState.getVar('chat-1', 'se__imageMap').value).toEqual({ k: 'v' });
        });

        it('an image list keeps its order (never sorted) and its duplicates', () => {
            realChatState.setVar('chat-1', 'se__imageList', ['c', 'a', 'a', 'b'], def('imageList', { sorted: true, unique: false }));
            expect(realChatState.getVar('chat-1', 'se__imageList').value).toEqual(['c', 'a', 'a', 'b']);
        });

        it('the value is mirrored for macros', () => {
            realChatState.setVar('chat-1', 'se__imageMap', { k: 'v' }, def('imageMap'));
            expect(context.variables.local.get('se__imageMap')).toEqual({ k: 'v' });
        });
    });
});

describe('rotation: image list only', () => {
    beforeEach(() => settings.reset());
    const rotating = (operation) => def('imageList', { behaviors: { increment: true, prompted: false }, increment: { ...blankDefinition().increment, operation } });

    it('rotateNext moves the first image to the end; rotate brings the last to the front', () => {
        expect(realChatState.applyArrayOperation(['a', 'b', 'c'], 'rotateNext')).toEqual(['b', 'c', 'a']);
        expect(realChatState.applyArrayOperation(['a', 'b', 'c'], 'rotate')).toEqual(['c', 'a', 'b']);
        expect(realChatState.applyArrayOperation(['a'], 'rotateNext')).toEqual(['a']);
        expect(realChatState.applyArrayOperation([], 'rotateNext')).toEqual([]);
    });

    it('an increment on an image list rotates it, and the first element is what the tracker shows', () => {
        const d = rotating('rotateNext');
        realChatState.setVar('chat-1', d.name, ['a', 'b', 'c'], d);
        realChatState.applyIncrement('chat-1', d.name, 1, d);
        expect(realChatState.getVar('chat-1', d.name).value).toEqual(['b', 'c', 'a']);
        expect(activeImageRef(d, realChatState.getVar('chat-1', d.name).value)).toBe('b');

        const back = rotating('rotate');
        realChatState.applyIncrement('chat-1', back.name, 1, back);
        expect(realChatState.getVar('chat-1', back.name).value).toEqual(['a', 'b', 'c']);
    });

    it('with no rotation configured, nothing happens (no automatic rotation)', () => {
        const d = rotating(null);
        realChatState.setVar('chat-1', d.name, ['a', 'b'], d);
        realChatState.applyIncrement('chat-1', d.name, 1, d);
        expect(realChatState.getVar('chat-1', d.name).value).toEqual(['a', 'b']);
    });

    it('an image or an image map never rotates, whatever it is asked', () => {
        const map = def('imageMap', { behaviors: { increment: true, prompted: false }, increment: { ...blankDefinition().increment, operation: 'rotateNext' } });
        realChatState.setVar('chat-1', map.name, { k: 'v' }, map);
        realChatState.applyIncrement('chat-1', map.name, 1, map);
        expect(realChatState.getVar('chat-1', map.name).value).toEqual({ k: 'v' });

        const image = def('image', { behaviors: { increment: true, prompted: false } });
        realChatState.setVar('chat-1', image.name, 'a.png', image);
        realChatState.applyIncrement('chat-1', image.name, 1, image);
        expect(realChatState.getVar('chat-1', image.name).value).toBe('a.png');
    });
});

describe('which image is showing', () => {
    it('image: its value; empty -> none', () => {
        expect(activeImageRef(def('image'), 'a.png')).toBe('a.png');
        expect(activeImageRef(def('image'), '')).toBe(null);
        expect(activeImageRef(def('image'), 5)).toBe(null);
    });

    it('imageList: the first element; empty -> none; not the whole list', () => {
        expect(activeImageRef(def('imageList'), ['a.png', 'b.png'])).toBe('a.png');
        expect(activeImageRef(def('imageList'), [])).toBe(null);
        expect(activeImageRef(def('imageList'), ['', 'b.png'])).toBe(null);
        expect(activeImageRef(def('imageList'), 'nope')).toBe(null);
    });

    it('imageMap: the image under the current key; no key or no such key -> none, never a fallback', () => {
        const map = { happy: 'h.png', sad: 's.png', default: 'd.png' };
        expect(activeImageRef(def('imageMap'), map, 'sad')).toBe('s.png');
        expect(activeImageRef(def('imageMap'), map, 'angry')).toBe(null);   // no default key, even though "default" exists
        expect(activeImageRef(def('imageMap'), map, undefined)).toBe(null);
        expect(activeImageRef(def('imageMap'), map, null)).toBe(null);
        expect(activeImageRef(def('imageMap'), {}, 'happy')).toBe(null);
    });

    it('other types show nothing', () => {
        expect(activeImageRef({ type: 'string' }, 'a.png')).toBe(null);
        expect(activeImageRef(undefined, 'a.png')).toBe(null);
    });
});

describe('the key of an image map is the resolved value of any variable, read as text', () => {
    it('a string variable', () => expect(resolveKeyString('happy')).toBe('happy'));
    it('an enum variable (a string)', () => expect(resolveKeyString('fight')).toBe('fight'));
    it('a calculated variable\'s result: numbers and booleans read as their text', () => {
        expect(resolveKeyString(3)).toBe('3');
        expect(resolveKeyString(0)).toBe('0');
        expect(resolveKeyString(true)).toBe('true');
        expect(resolveKeyString(false)).toBe('false');
    });
    it('an array variable\'s current resolved value: its first element, as text', () => {
        expect(resolveKeyString(['happy'])).toBe('happy');
        expect(resolveKeyString(['happy', 'sad'])).toBe('happy');
        expect(resolveKeyString([7])).toBe('7');
        expect(resolveKeyString([])).toBe(null);
    });
    it('nothing that is not text-like resolves', () => {
        expect(resolveKeyString({ a: 'b' })).toBe(null);
        expect(resolveKeyString(null)).toBe(null);
        expect(resolveKeyString(undefined)).toBe(null);
    });

    it('drives the lookup end to end: a hit returns the reference, a miss returns null', () => {
        const map = { 3: 'three.png', true: 'yes.png', happy: 'h.png' };
        expect(resolveMapImage(map, resolveKeyString(3))).toBe('three.png');
        expect(resolveMapImage(map, resolveKeyString(true))).toBe('yes.png');
        expect(resolveMapImage(map, resolveKeyString(['happy', 'sad']))).toBe('h.png');
        expect(resolveMapImage(map, resolveKeyString('missing'))).toBe(null);
        expect(resolveMapImage(map, resolveKeyString([]))).toBe(null);
    });

    it('only the map\'s own keys count - "constructor" and "__proto__" are not keys', () => {
        expect(resolveMapImage({}, 'constructor')).toBe(null);
        expect(resolveMapImage({}, 'toString')).toBe(null);
        expect(resolveMapImage(JSON.parse('{"__proto__":"p.png"}'), '__proto__')).toBe('p.png'); // a real own key of parsed JSON
        expect(resolveMapImage({ a: 'x' }, null)).toBe(null);
        expect(resolveMapImage('nope', 'a')).toBe(null);
    });
});

describe('safe sources', () => {
    it('allows http(s) URLs, data:image URLs and paths', () => {
        for (const ok of ['https://x.test/a.png', 'http://x.test/a', 'data:image/png;base64,AAAA', 'data:image/svg+xml;base64,PHN2Zz4=',
            '/user/images/a.png', './a.png', '../a.png', 'portraits/a', 'a.PNG', 'sprite.webp?v=2']) {
            expect(safeImageSrc(ok), ok).toBe(ok);
        }
    });

    it('refuses anything that could run or is not an image reference', () => {
        for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'vbscript:x', 'file:///etc/passwd', 'data:text/html;base64,PHNjcmlwdD4=',
            'data:image/png,notbase64-but-no-semicolon', 'blob:https://x/1', 'asset:portrait-12', 'portrait_12', 'just words', '', '   ', 'a .png', 'a\n.png', null, undefined, 5, {}]) {
            expect(safeImageSrc(bad), JSON.stringify(bad)).toBe(null);
        }
    });

    it('trims, and never returns anything but the reference itself', () => {
        expect(safeImageSrc('  https://x.test/a.png  ')).toBe('https://x.test/a.png');
    });
});

describe('expressions: lookups and behaving like strings, arrays and objects', () => {
    const ev = (expression, values) => evaluateExpression(expression, Object.keys(values), values);

    it('portraits[currentEmotion]: an image map is looked up by a string variable', () => {
        const values = { portraits: { happy: 'h.png', sad: 's.png' }, currentEmotion: 'sad' };
        expect(ev('portraits[currentEmotion]', values)).toEqual({ ok: true, value: 's.png' });
        expect(ev('portraits["happy"]', values)).toEqual({ ok: true, value: 'h.png' });
    });

    it('a number or boolean key is read as text', () => {
        expect(ev('m[n]', { m: { 3: 'three.png' }, n: 3 })).toEqual({ ok: true, value: 'three.png' });
        expect(ev('m[b]', { m: { true: 'yes.png' }, b: true })).toEqual({ ok: true, value: 'yes.png' });
    });

    it('a missing key or index is an error (the variable keeps its previous value), never a guess', () => {
        expect(ev('portraits[e]', { portraits: { happy: 'h.png' }, e: 'angry' })).toEqual({ ok: false, error: 'No entry named "angry"' });
        expect(ev('gallery[5]', { gallery: ['a', 'b'] }).error).toMatch(/out of range/);
        expect(ev('gallery[-1]', { gallery: ['a'] }).ok).toBe(false);
        expect(ev('gallery[0.5]', { gallery: ['a'] }).error).toMatch(/whole number/);
        expect(ev('portraits["constructor"]', { portraits: {} }).ok).toBe(false);
    });

    it('an image list behaves like an array: index, length, contains', () => {
        expect(ev('gallery[1]', { gallery: ['a.png', 'b.png'] })).toEqual({ ok: true, value: 'b.png' });
        expect(ev('gallery.length', { gallery: ['a.png', 'b.png'] })).toEqual({ ok: true, value: 2 });
        expect(ev('gallery.contains("a.png")', { gallery: ['a.png', 'b.png'] })).toEqual({ ok: true, value: true });
        expect(ev('gallery[i]', { gallery: ['a', 'b'], i: 1 })).toEqual({ ok: true, value: 'b' });
    });

    it('an image behaves like a string', () => {
        expect(ev('icon.upper()', { icon: 'a.png' })).toEqual({ ok: true, value: 'A.PNG' });
        expect(ev('icon.length', { icon: 'a.png' })).toEqual({ ok: true, value: 5 });
        expect(ev('icon == "a.png"', { icon: 'a.png' })).toEqual({ ok: true, value: true });
        expect(ev('portraits[e].length', { portraits: { happy: 'abc' }, e: 'happy' })).toEqual({ ok: true, value: 3 });
    });

    it('only arrays and objects can be indexed, and only to a primitive', () => {
        expect(ev('s[0]', { s: 'text' }).error).toMatch(/Only an array or an object/);
        expect(ev('n[0]', { n: 5 }).ok).toBe(false);
        expect(ev('parties[0]', { parties: [['x']] }).error).toMatch(/must produce/);
        expect(ev('o[k]', { o: { a: 'x' }, k: ['a'] }).error).toMatch(/object key must be a string/);
    });

    it('dependencies are found through the index', () => {
        expect(extractIdentifiers('portraits[currentEmotion]')).toEqual({ ok: true, identifiers: ['portraits', 'currentEmotion'] });
        expect(extractIdentifiers('a[b[c]]').identifiers.sort()).toEqual(['a', 'b', 'c']);
    });

    it('unclosed or empty brackets are syntax errors', () => {
        expect(ev('a[', { a: [] }).ok).toBe(false);
        expect(ev('a[]', { a: [] }).ok).toBe(false);
        expect(ev('a[0', { a: [1] }).ok).toBe(false);
    });
});
