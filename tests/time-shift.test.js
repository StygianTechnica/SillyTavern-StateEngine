// readTimeShift: the time story prose passes or reaches, read in one place
// for State Engine and the extensions that keep their own clock (moved here
// from Scenario Builder, with its cases).
import { describe, it, expect } from 'vitest';
import { readTimeShift } from '../src/core/time-shift.js';

const skip = (t) => readTimeShift(t).skip;
const reached = (t) => readTimeShift(t).reached;
const elapsed = (t) => readTimeShift(t).elapsed;
const delta = (t) => readTimeShift(t).delta;

describe('a skip the post makes', () => {
    it('at the start of a sentence', () => {
        expect(skip('Early the next morning, Zane drove Cyril back to the Signal box on his motorcycle.')).toEqual({ advance: 'the next morning', sameDay: false });
        expect(skip('The next day, Cyril went to the range.')).toEqual({ advance: 'the next morning', sameDay: false });
        expect(skip('The following evening they met again.')).toEqual({ advance: 'the next evening', sameDay: false });
        expect(skip('The morning after, he woke sore.')).toEqual({ advance: 'the next morning', sameDay: false });
        expect(skip('Next morning he was gone.')).toEqual({ advance: 'the next morning', sameDay: false });
        expect(skip('*Overnight, the rain stopped.*')).toEqual({ advance: 'the next morning', sameDay: false });
        expect(skip('Cyril slept like the dead. The next morning he felt better.')).toEqual({ advance: 'the next morning', sameDay: false });
    });

    it('spans, counted or not', () => {
        expect(skip('Two days later, the call came.')).toEqual({ advance: 'two days', sameDay: false });
        expect(skip('Hours later, Cyril woke.')).toEqual({ advance: 'a few hours', sameDay: false });
        expect(skip('An hour later he was back.')).toEqual({ advance: 'one hour', sameDay: false });
    });

    it('later the same day, never into tomorrow', () => {
        expect(skip('Later that evening, Cyril found the gym.')).toEqual({ advance: 'until evening', sameDay: true });
        expect(skip('By nightfall the city was quiet.')).toEqual({ advance: 'until evening', sameDay: true });
        expect(skip('At dawn, they set out.')).toEqual({ advance: 'until dawn', sameDay: false });
    });

    // Assassins Inc: three posts that left the clock at midday.
    it('told anywhere in the sentence', () => {
        expect(skip('Cyril was bored, but he eventually settled into binge watching a series he found. The rest of the day went by quickly and he eventually dropped off to sleep with the entertainment feed running.')).toEqual({ advance: 'until evening', sameDay: true });
        expect(skip('Cyril managed to pass the night without experiencing nightmares.')).toEqual({ advance: 'until morning', sameDay: false });
        expect(skip('Before too long, morning dawned and it was coming time soon for him to start his exercise at last.')).toEqual({ advance: 'until morning', sameDay: false });
        expect(skip('The night passed without incident.')).toEqual({ advance: 'until morning', sameDay: false });
    });

    it('the furthest skip a post tells', () => {
        expect(skip('The rest of the day went by. Cyril managed to pass the night without nightmares.')).toEqual({ advance: 'until morning', sameDay: false });
    });

    it('never speech, a mention mid-sentence, or what will be', () => {
        expect(skip('"The next morning we ride," Cyril said.')).toBeNull();
        expect(skip('Cyril decided to leave the next morning.')).toBeNull();
        expect(skip('The next morning would bring trouble, he knew.')).toBeNull();
        expect(skip("Tomorrow he'll go back.")).toBeNull();
        expect(skip('Cyril nodded and went to find the gym.')).toBeNull();
        expect(skip('He hoped to pass the night in peace.')).toBeNull();
        expect(skip('"Morning came too early," Zane grumbled.')).toBeNull();
    });
});

describe('the time of day the text shows reached', () => {
    const sunset = 'The sun began to set over the fortress walls as it turned darker and colder. It was time for them to get some rest; he had a feeling their meeting with Graxx would not end so smoothly in the morning.';

    it('reads the day turning in plain narration', () => {
        expect(reached(sunset)).toEqual({ phrase: 'sunset', fraction: 0.77 });
        expect(reached('Night fell over the wastes.')).toEqual({ phrase: 'night', fraction: 0.88 });
        expect(reached('Dawn broke grey and cold.')).toEqual({ phrase: 'dawn', fraction: 0.25 });
        expect(reached("It was morning at last and the sun's glowing rays bathed the battlefield in golden hues.")?.phrase).toBe('morning');
        expect(reached('Remus was unconscious for the rest of the battle until well after daybreak.')?.phrase).toBe('morning');
    });

    it('the other ways dawn is told', () => {
        const watch = [
            'As Niamh awakened Remus from his rest, he rose with a quiet efficiency, his eyes already adjusting to the dim light of dawn as he took up his post at the ruin\'s perimeter.',
            'As the first pale light of sunrise crept over the horizon, Remus\'s vigilance never wavered.',
        ].join('\n\n');
        expect(reached(watch)).toEqual({ phrase: 'dawn', fraction: 0.25 });
        expect(reached('Remus stood watch in the dawn’s early light.')?.phrase).toBe('dawn');
        expect(reached('The first grey light of morning touched the walls.')?.phrase).toBe('dawn');
        expect(reached('A pale glow crept over the horizon.')?.phrase).toBe('dawn');
    });

    it('ignores what is said about later, awaited, or a likeness', () => {
        expect(reached('They would leave when the sun set.')).toBeNull();
        expect(reached('We ride at dawn, before the sun rises.')).toBeNull();
        expect(reached('Graxx paced the hall.')).toBeNull();
        expect(reached('We will rest until well after daybreak.')).toBeNull();
        expect(reached('"We ride at first light, when sunrise breaks," Niamh said.')).toBeNull();
        expect(reached('“Wake me at the light of dawn,” she murmured, and lay down.')).toBeNull();
        expect(reached('He waited for the light of dawn.')).toBeNull();
        expect(reached('Her smile was like the light of dawn.')).toBeNull();
        expect(reached('It was the dawn of a new age for the clans.')).toBeNull();
        expect(reached('Hours remained before the light of dawn.')).toBeNull();
    });
});

describe('time told as passed', () => {
    it('a span told as passed', () => {
        expect(elapsed('"The stubborn fool has been gone for hours," Graxx grumbled.')).toBe('a few hours');
        expect(elapsed('Two hours later they reached the gate.')).toBe('two hours');
        expect(elapsed('After several hours of marching, they rested.')).toBe('a few hours');
        expect(elapsed('An hour passed in silence.')).toBe('one hour');
        expect(elapsed('Three days later, the envoy returned.')).toBe('three days');
        expect(elapsed('Over the next hour, they gathered and packed their belongings back onto the horses.')).toBe('one hour');
        expect(elapsed('For the next two hours they rode in silence.')).toBe('two hours');
        expect(elapsed('Throughout the following hours, the rain kept on.')).toBe('a few hours');
    });

    // Assassins Inc #240, #242: said of an ordinary evening.
    it('never "after a long day", an idiom - only a counted day', () => {
        expect(elapsed('"It\'s the perfect place for me to unwind after a long day of work."')).toBe('');
        expect(elapsed('"I find it helps me relax after a long day."')).toBe('');
        expect(elapsed('After a hard day, Zane cooked.')).toBe('');
        expect(elapsed('After two days of rain, the roads flooded.')).toBe('two days');
        expect(elapsed('After several days, the envoy returned.')).toBe('a few days');
        expect(elapsed('After an hour, he came back.')).toBe('one hour');
    });

    it('uncounted hours creeping by', () => {
        expect(elapsed("His glowing optics never wavered from the door, even as the hours crept by and the stronghold quieted into the late evening.")).toBe('a few hours');
    });

    it('leaves what will be, moments, backstory, and speech', () => {
        expect(elapsed('We will rest for hours.')).toBe('');
        expect(elapsed('She waited for a moment.')).toBe('');
        expect(elapsed('It was hours before dawn.')).toBe('');
        expect(elapsed('She had been travelling for days before they met.')).toBe('');
        expect(elapsed('"We ride for the next two hours," Niamh said.')).toBe('');
        expect(elapsed("We'll rest over the next hour.")).toBe('');
        expect(elapsed('Over the next few minutes, he caught his breath.')).toBe('');
    });
});

describe('a short "how much time passed" answer', () => {
    it('a span as a span, never the moment it describes', () => {
        expect(delta('minutes into the night')).toBe('a few minutes');
        expect(delta('into the night')).toBe('');
        expect(delta('late evening')).toBe('');
        expect(delta('two hours')).toBe('two hours');
        expect(delta('20 minutes later.')).toBe('20 minutes');
    });

    it('keeps a jump it asks for', () => {
        expect(delta('the next morning')).toBe('the next morning');
        expect(delta('until dawn')).toBe('until dawn');
        expect(delta('overnight')).toBe('overnight');
        expect(delta('from late night through dawn')).toBe('until dawn');
        expect(delta('through the night until morning')).toBe('until morning');
    });
});

describe('the reading as a whole', () => {
    it('empty text reads as nothing', () => {
        expect(readTimeShift('')).toEqual({ skip: null, reached: null, elapsed: '', delta: '' });
        expect(readTimeShift(undefined)).toEqual({ skip: null, reached: null, elapsed: '', delta: '' });
    });
});
