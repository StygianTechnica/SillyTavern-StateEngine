// An answer cut off by the token limit (finish_reason "length"): the values
// the model finished are kept (formatting-utils.js salvageTruncatedObject),
// and a variable marked ANSWER LAST is asked last, so it is the one lost
// (prompted-engine.js classifyPromptedVariables).

import { extractJsonObject, extractJsonAnswer, salvageTruncatedObject, matchAnswerKeys, repairJson } from '../src/ui/formatting-utils.js';
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

describe('a shortened variable name in the answer', () => {
    beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
    const names = ['se__scene_id', 'se__scene_characters', 'se__scene_weather', 'se__scene_deltatime', 'se__scene_location', 'archivist__memories'];

    it('is taken as the one variable it clearly means (the reported answer)', () => {
        const answer = { se__scene_id: 'room', se__characters: ['Syrvanus Voxaris'], se__weather: [], se__deltatime: '5 minutes', __characters: { x: {} } };
        expect(matchAnswerKeys(answer, names)).toEqual({
            se__scene_id: 'room', se__scene_characters: ['Syrvanus Voxaris'], se__scene_weather: [], se__scene_deltatime: '5 minutes', __characters: { x: {} },
        });
    });

    it('is left alone when ambiguous, in another namespace, already answered, or matching nothing', () => {
        expect(matchAnswerKeys({ se__scene: 1 }, names)).toEqual({ se__scene: 1 });
        expect(matchAnswerKeys({ other__characters: 1 }, names)).toEqual({ other__characters: 1 });
        expect(matchAnswerKeys({ se__characters: 1, se__scene_characters: 2 }, names)).toEqual({ se__characters: 1, se__scene_characters: 2 });
        expect(matchAnswerKeys({ se__mood: 1 }, names)).toEqual({ se__mood: 1 });
    });

    it('returns the same object when nothing changes', () => {
        const answer = { se__scene_id: 'x' };
        expect(matchAnswerKeys(answer, names)).toBe(answer);
    });
});

describe('notes and comments in an answer', () => {
    beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));

    it('are dropped, so the answer still reads (the reported compiler answer)', () => {
        const raw = `{
  "archivist__compiled_characters": [
    {"name":"Alvaryx", "traits":["absent-minded?"],
     "motivations":[] (unknown),
     "stressors":[] (none (really) shown),
     "arc":"Unknown (for now)."}
  ]
}`;
        expect(extractJsonObject(raw)).toEqual({
            archivist__compiled_characters: [{ name: 'Alvaryx', traits: ['absent-minded?'], motivations: [], stressors: [], arc: 'Unknown (for now).' }],
        });
    });

    it('drops comments and trailing commas, never touching strings', () => {
        expect(repairJson('{"a": "x (y), z, }", // note\n "b": [1, 2,], /* c */ "c": "http://x"}'))
            .toBe('{"a": "x (y), z, }", \n "b": [1, 2],  "c": "http://x"}');
        expect(extractJsonObject('{"a": 1, "b": [1, 2,],}')).toEqual({ a: 1, b: [1, 2] });
    });

    it('quotes bare words used as values (the reported compiler answer)', () => {
        const raw = `{
  "archivist__compiled_facts": [
    {"id": f4, "text": "Zeno's doing, (not) true or false.", "sources": ["m4"], "ok": true, "none": null, "n": -3}
  ],
  "archivist__compiled_characters": [
    {"name": "Rydia", "sources": ["m1", "m4", m6, m7"]},
    {"name": "gremlins (lead)", "sources": [m2, m3]}
  ]
}`;
        expect(extractJsonObject(raw)).toEqual({
            archivist__compiled_facts: [{ id: 'f4', text: "Zeno's doing, (not) true or false.", sources: ['m4'], ok: true, none: null, n: -3 }],
            archivist__compiled_characters: [
                { name: 'Rydia', sources: ['m1', 'm4', 'm6', 'm7'] },
                { name: 'gremlins (lead)', sources: ['m2', 'm3'] },
            ],
        });
    });

    it('reads multi-word bare values, drops "..." elisions, and closes a missing final brace (the reported 8B answer)', () => {
        const raw = `{
  "archivist__compiled_facts": [
    {"id": f1, "text": "Remus was late.", "entities": ["Remus Watt"], "sources": [m1], "contradicts": []},
    ...,
    {"id": f40, "text": "Varyn fights out of necessity.", "sources": [m49], "contradicts": [f1]}
  ],
  "archivist__compiled_relationships": [
    {"from": Remus Watt, "to": High Seer Maren, "type": mentor, "polarity": 2, "trend": cooling, "sources": [m3, m5]},
    {"from": Lila Thorne, "to": Remus Watt, "type": friend, "sources": [m1, ...]},
    ...
    {"from": Varyn Vance, "to": Morvath, "type": opponent, "polarity": -3, "sources": [m49]}
  ],
  "archivist__compiled_characters": [
    {"name": Remus Watt, "sources": [m1, m5, ...]},
    …
  ],
  "archivist__compiled_phrase_tics": [{"ref": [p1], "phrase": "a wry smile"}],
  "archivist__compiled_tension":
  [{"threat": 2, "uncertainty": 4, "emotional": 3, "reason": "Unknown perils... in Liston."}]`;
        expect(extractJsonObject(raw)).toEqual({
            archivist__compiled_facts: [
                { id: 'f1', text: 'Remus was late.', entities: ['Remus Watt'], sources: ['m1'], contradicts: [] },
                { id: 'f40', text: 'Varyn fights out of necessity.', sources: ['m49'], contradicts: ['f1'] },
            ],
            archivist__compiled_relationships: [
                { from: 'Remus Watt', to: 'High Seer Maren', type: 'mentor', polarity: 2, trend: 'cooling', sources: ['m3', 'm5'] },
                { from: 'Lila Thorne', to: 'Remus Watt', type: 'friend', sources: ['m1'] },
                { from: 'Varyn Vance', to: 'Morvath', type: 'opponent', polarity: -3, sources: ['m49'] },
            ],
            archivist__compiled_characters: [{ name: 'Remus Watt', sources: ['m1', 'm5'] }],
            archivist__compiled_phrase_tics: [{ ref: ['p1'], phrase: 'a wry smile' }],
            archivist__compiled_tension: [{ threat: 2, uncertainty: 4, emotional: 3, reason: 'Unknown perils... in Liston.' }],
        });
    });

    it('reads bare text with notes and colons as one value, up to the next key (the reported 8B answer)', () => {
        const raw = `{
  "archivist__compiled_relationships": [
    {"from": Remus Watt, "to": High Seer Maren, "type": mentor · wary (-1) · high intensity · cooling: Disputes her interpretation of his visions, "polarity": -1, "sources": [m3]},
    {"from": Remus Watt, "to": Varyn Vance, "type": traveling companion · friendly (2) · warming: Shared experiences deepen their connection., "polarity": 2, "sources": [m8, m28]}
  ],
  "archivist__compiled_characters": [
    {"name": Remus Watt,
     "id": f4", "ok": true , "none": null}
  ]}`;
        expect(extractJsonObject(raw)).toEqual({
            archivist__compiled_relationships: [
                { from: 'Remus Watt', to: 'High Seer Maren', type: 'mentor · wary (-1) · high intensity · cooling: Disputes her interpretation of his visions', polarity: -1, sources: ['m3'] },
                { from: 'Remus Watt', to: 'Varyn Vance', type: 'traveling companion · friendly (2) · warming: Shared experiences deepen their connection.', polarity: 2, sources: ['m8', 'm28'] },
            ],
            archivist__compiled_characters: [{ name: 'Remus Watt', id: 'f4', ok: true, none: null }],
        });
    });

    it('puts back commas left out before a key or a list item, and reads a bare value on its own line (the reported 8B answer)', () => {
        const raw = `{
  "archivist__compiled_characters": [
    {"name": Remus Watt,
     "summary": An initiate fleeing visions. He left the Enclave in secret., 
     "traits": curious, introspective,
     "habits": none mentioned,
     "sources": [m1]}
    {"name": Varyn Vance, "n": 2
     "sources": ["m1" "m2"]}
  ],
  "archivist__compiled_story_summary": 
  Remus Watt fled visions of Elyon's return. Now they're at an old interstate section.
  "archivist__compiled_scene_summary": 
  Remus Watt and Varyn Vance are on an old highway.
  "archivist__compiled_phrase_tics": [],  
  "archivist__compiled_tension":
  {
    "threat": 2,
    "reason": "Uncertain next steps."
  }
}`;
        expect(extractJsonObject(raw)).toEqual({
            archivist__compiled_characters: [
                { name: 'Remus Watt', summary: 'An initiate fleeing visions. He left the Enclave in secret.', traits: 'curious, introspective', habits: 'none mentioned', sources: ['m1'] },
                { name: 'Varyn Vance', n: 2, sources: ['m1', 'm2'] },
            ],
            archivist__compiled_story_summary: "Remus Watt fled visions of Elyon's return. Now they're at an old interstate section.",
            archivist__compiled_scene_summary: 'Remus Watt and Varyn Vance are on an old highway.',
            archivist__compiled_phrase_tics: [],
            archivist__compiled_tension: { threat: 2, reason: 'Uncertain next steps.' },
        });
        // Commas already there are left alone.
        expect(repairJson('{"a": "x", "b": ["c", "d"]}')).toBe('{"a": "x", "b": ["c", "d"]}');
    });

    it('fixes swapped closing brackets and a list closed too soon (the reported 8B answers)', () => {
        const swapped = `{
  "archivist__compiled_threads": [
    {"id": t2, "steps": [{"text": "Discuss", "status": "pending", "note": ""}, {"text": "Adapt", "status": "pending", "note": ""]}, "sources": []},
    {"id": t8, "steps": [{"text": "Explore", "status": "active", "note": ""}], "sources": [m1, m3]}
  ]
}`;
        expect(extractJsonObject(swapped)).toEqual({
            archivist__compiled_threads: [
                { id: 't2', steps: [{ text: 'Discuss', status: 'pending', note: '' }, { text: 'Adapt', status: 'pending', note: '' }], sources: [] },
                { id: 't8', steps: [{ text: 'Explore', status: 'active', note: '' }], sources: ['m1', 'm3'] },
            ],
        });
        const early = `{
  "archivist__compiled_threads": [{"id": t2, "title": "Remus' Departure"}],
  "archivist__compiled_world": [
    {"id": w1, "kind": "location", "name": "Enclave", "sources": [m1]}
  ], {"id": w2, "kind": "secret",
     "name": "Remus' connection to Elyon", "sources": [m3]}
  ]
}`;
        expect(extractJsonObject(early)).toEqual({
            archivist__compiled_threads: [{ id: 't2', title: 'Remus\' Departure' }],
            archivist__compiled_world: [
                { id: 'w1', kind: 'location', name: 'Enclave', sources: ['m1'] },
                { id: 'w2', kind: 'secret', name: 'Remus\' connection to Elyon', sources: ['m3'] },
            ],
        });
        // Valid nesting is left alone.
        expect(repairJson('{"a": [{"b": [1]}], "c": {"d": []}}')).toBe('{"a": [{"b": [1]}], "c": {"d": []}}');
    });

    it('takes a bare list as the one list variable asked for, and quotes bare #numbers (the reported catch-up answers)', () => {
        const list = { name: 'archivist__catchup_memories', type: 'array' };
        const valid = `[
  {"text": "Remus and Varyn share a peaceful moment.", "subtype": "event", "message_index": "#94"},
  {"text": "Varyn discusses his past as Ferunox's agent.", "entities": ["Remus Watt", "Ferunox"], "message_index": "#98"}
]`;
        expect(extractJsonAnswer(valid, [list])).toEqual({ archivist__catchup_memories: [
            { text: 'Remus and Varyn share a peaceful moment.', subtype: 'event', message_index: '#94' },
            { text: 'Varyn discusses his past as Ferunox\'s agent.', entities: ['Remus Watt', 'Ferunox'], message_index: '#98' },
        ] });
        const hashes = `[
  {"text": "Remus hopes to find an old road.", "entities": ["Remus Watt", "civilization"], "message_index": #180},
  {"text": "Remus believes Elyon guides him.", "present": [ ], "message_index": #182}
]`;
        expect(extractJsonAnswer(hashes, [list]).archivist__catchup_memories.map((m) => m.message_index)).toEqual(['#180', '#182']);
        // Two variables asked for, or one that is not a list: a bare list can't be placed.
        expect(extractJsonAnswer(valid, [list, { name: 'other', type: 'array' }])).toBeNull();
        expect(extractJsonAnswer(valid, [{ name: 'mood', type: 'string' }])).toBeNull();
        // An object answer is read as always.
        expect(extractJsonAnswer('{"archivist__catchup_memories": []}', [list])).toEqual({ archivist__catchup_memories: [] });
    });

    it('does not close a list a cut-off answer left open', () => {
        expect(extractJsonObject('{"a": 1, "b": [1, 2')).toEqual({ a: 1 });
        expect(extractJsonObject('{"a": 1, "b": [1, 2]')).toEqual({ a: 1, b: [1, 2] });
    });

    it('drops a stray brace inside an object, closes lists left open, and reads unquoted keys (the reported 8B answers)', () => {
        const raw = `{
  "facts": [
    {"id":"f24",
     "text":"A guard warned Varyn.",
     {"entities":["Varyn Vance", "guard"],
      "sources":[m15]}
  ],
  "more": [
    {id: f19, text: "... (remains the same)", sources: [...], contradict: [...]},  // a note
    ...
  ],
  "relationships": [
    {"from": "Remus Watt", "to": "Varyn Vance"},
    ...

  "characters":
  [
    {"name": "Remus Watt"},

  "story":
  Remus and Varyn reached Liston.

  "tension": [
    {"threat": 2, "reason": "Unknown perils"}`;
        expect(extractJsonObject(raw)).toEqual({
            facts: [{ id: 'f24', text: 'A guard warned Varyn.', entities: ['Varyn Vance', 'guard'], sources: ['m15'] }],
            more: [{ id: 'f19', text: '... (remains the same)', sources: [], contradict: [] }],
            relationships: [{ from: 'Remus Watt', to: 'Varyn Vance' }],
            characters: [{ name: 'Remus Watt' }],
            story: 'Remus and Varyn reached Liston.',
            tension: [{ threat: 2, reason: 'Unknown perils' }],
        });
    });

    it('still keeps what a cut-off answer with notes finished', () => {
        expect(extractJsonObject('{"a": [] (none), "b": "unfin')).toEqual({ a: [] });
    });
});
