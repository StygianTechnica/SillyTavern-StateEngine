// An answer cut off by the token limit (finish_reason "length"): the values
// the model finished are kept (formatting-utils.js salvageTruncatedObject),
// and a variable marked ANSWER LAST is asked last, so it is the one lost
// (prompted-engine.js classifyPromptedVariables).

import { extractJsonObject, salvageTruncatedObject } from '../src/ui/formatting-utils.js';
import { classifyPromptedVariables } from '../src/core/prompted-engine.js';

vi.mock('../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

describe('a cut-off answer', () => {
    beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));

    it('keeps every value finished before the cut (the reported case)', () => {
        const raw = '{\n"archivist__memories": [\n  {"text": "A gremlin offered help, {braces} and \\"quotes\\" inside.", "tags": ["important"]}\n],\n"se__scene_id": "mn';
        expect(extractJsonObject(raw)).toEqual({
            archivist__memories: [{ text: 'A gremlin offered help, {braces} and "quotes" inside.', tags: ['important'] }],
        });
        expect(console.warn).toHaveBeenCalled();
    });

    it('keeps a finished value with no comma after it yet', () => {
        expect(extractJsonObject('{"a": 1, "b": [1, 2]')).toEqual({ a: 1, b: [1, 2] });
        expect(extractJsonObject('{"a": "x", "b": {"c": 1}')).toEqual({ a: 'x', b: { c: 1 } });
    });

    it('drops a half-written scalar', () => {
        expect(extractJsonObject('{"a": 1, "b": 12')).toEqual({ a: 1 });
        expect(extractJsonObject('{"a": "unfinish')).toBeNull();
    });

    it('still reads a complete answer as before, and refuses one broken some other way', () => {
        expect(extractJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
        expect(salvageTruncatedObject('{"a": 1}, oops}')).toBeNull();
        expect(extractJsonObject('no json here')).toBeNull();
    });
});

describe('answer last', () => {
    const def = (name, extra = {}) => ({ name, type: 'string', behaviors: { prompted: true, increment: false }, prompted: { instructions: 'x', ...extra } });

    it('puts variables marked answerLast after the others, keeping each group\'s order', () => {
        const { updateVars } = classifyPromptedVariables('chat-1', {
            a: def('memories', { answerLast: true }), b: def('scene_id'), c: def('notes', { answerLast: true }), d: def('weather'),
        });
        expect(updateVars.map((v) => v.name)).toEqual(['scene_id', 'weather', 'memories', 'notes']);
    });
});
