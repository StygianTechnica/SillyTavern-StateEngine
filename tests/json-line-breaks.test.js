// Raw line breaks inside strings (formatting-utils.js repairJson): a value
// left unclosed - "status":"<line break>, (Archivist's compile, God War,
// 2026-10-17) - is closed; text running over two lines keeps its break.

import { extractJsonObject, repairJson } from '../src/ui/formatting-utils.js';

describe('line breaks inside strings', () => {
    it('close a value the model left open before the next comma or bracket', () => {
        const answer = [
            '{',
            '  "ar__compiled_world":[',
            '    {',
            '      "id":"w11",',
            '      "kind":"location",',
            '      "name":"",',
            '      "text":"A place where Remus and Varyn decided to spend the night.",',
            '      "involved":["Remus Watt","Varyn Vance"],',
            '      "status":"',
            ',',
            '      "sources":[]',
            '    },',
            '    {',
            '      "id":"w13",',
            '      "kind":"event",',
            '      "text":"Niamh\'s fortress is under attack by zombies.",',
            '      "status":"ongoing",',
            '      "sources":[]',
            '    },',
            '    {',
            '      "id":"w4",',
            '      "kind":"lore",',
            '      "text":"The Death god\'s spreading influence has led to an increase in zombie activity.",',
            '      "status":"',
            ',',
            '      "sources":[]',
            '    }',
            '  ]',
            '}',
        ].join('\n');
        const parsed = extractJsonObject(answer);
        expect(parsed.ar__compiled_world).toHaveLength(3);
        expect(parsed.ar__compiled_world[0]).toMatchObject({ id: 'w11', status: '', sources: [] });
        expect(parsed.ar__compiled_world[1].status).toBe('ongoing');
        expect(parsed.ar__compiled_world[2]).toMatchObject({ id: 'w4', status: '' });
    });

    it('close one left open before a closing bracket or the next key', () => {
        expect(JSON.parse(repairJson('{"a":"x\n}'))).toEqual({ a: 'x' });
        expect(JSON.parse(repairJson('{"a":"\n"b": 1}'))).toEqual({ a: '', b: 1 });
    });

    it('keep the break in text that runs over two lines', () => {
        expect(JSON.parse(repairJson('{"a":"first line\nsecond line"}'))).toEqual({ a: 'first line\nsecond line' });
    });

    it('leave escaped line breaks and valid JSON alone', () => {
        expect(JSON.parse(repairJson('{"a":"one\\ntwo"}'))).toEqual({ a: 'one\ntwo' });
        expect(repairJson('{"a": "b"}')).toBe('{"a": "b"}');
    });
});
