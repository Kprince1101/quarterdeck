import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DRIVER_TURN_INSTRUCTIONS,
  driverTurnResultSchema,
  parseTurnResult,
  repromptText,
} from '../../src/driver/index.js';

const parse = (text: string) => parseTurnResult(text, driverTurnResultSchema);

const RESULT = {
  summary: 'Assigned QD12.',
  actions: [{ kind: 'assign', ticket: 'QD12', agent: 'heron' }],
};

describe('parseTurnResult', () => {
  it('reads the JSON in a fenced block after prose', () => {
    const text = `I looked at the board.\n\n\`\`\`json\n${JSON.stringify(RESULT)}\n\`\`\`\n`;

    expect(parse(text)).toEqual({ ok: true, value: RESULT });
  });

  it('takes the last fenced block when the reply has several', () => {
    const draft = { summary: 'draft', actions: [] };
    const text = [
      '```json',
      JSON.stringify(draft),
      '```',
      'On second thought:',
      '```',
      JSON.stringify(RESULT),
      '```',
    ].join('\n');

    expect(parse(text)).toEqual({ ok: true, value: RESULT });
  });

  it('reads a reply that is only JSON', () => {
    expect(parse(`  ${JSON.stringify(RESULT)}\n`)).toEqual({
      ok: true,
      value: RESULT,
    });
  });

  it('reads an unfenced object after prose', () => {
    expect(parse(`Here it is: ${JSON.stringify(RESULT)}`)).toEqual({
      ok: true,
      value: RESULT,
    });
  });

  it('keeps the fields of each action beyond its kind', () => {
    const parsed = parse(JSON.stringify(RESULT));

    expect(parsed.ok && parsed.value.actions[0]).toEqual(RESULT.actions[0]);
  });

  it('says when the reply has no JSON object', () => {
    expect(parse('All done, nothing to report.')).toEqual({
      ok: false,
      error: 'the reply has no JSON object',
    });
  });

  it('says when the JSON does not parse', () => {
    const parsed = parse('```json\n{ "summary": "x", }\n```');

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(
      /^the reply's JSON does not parse: /,
    );
  });

  it('names the fields that do not match the shape', () => {
    const parsed = parse('```json\n{ "summary": "", "actions": [{}] }\n```');

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/does not match its shape/);
    expect(!parsed.ok && parsed.error).toContain('summary');
    expect(!parsed.ok && parsed.error).toContain('actions[0].kind');
  });

  it('reads back any valid result wrapped in prose', () => {
    const result = fc.record({
      summary: fc.string({ minLength: 1 }),
      actions: fc.array(
        fc.record({ kind: fc.string({ minLength: 1 }), note: fc.string() }),
      ),
    });
    const prose = fc.string().filter((text) => !/[{`]/.test(text));
    fc.assert(
      fc.property(result, prose, (value, before) => {
        const text = `${before}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
        expect(parse(text)).toEqual({ ok: true, value });
      }),
    );
  });
});

describe('repromptText', () => {
  it('carries the error and the format instructions', () => {
    const text = repromptText('the reply has no JSON object', 'FORMAT');

    expect(text).toContain('the reply has no JSON object');
    expect(text).toContain('FORMAT');
  });

  it('the Driver instructions show a result that parses', () => {
    const example = /```json\n([\s\S]*?)```/.exec(DRIVER_TURN_INSTRUCTIONS);

    expect(example?.[1]).toBeDefined();
    expect(parse(example?.[1] ?? '').ok).toBe(true);
  });
});
