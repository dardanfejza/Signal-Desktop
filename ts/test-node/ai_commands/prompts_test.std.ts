// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import {
  buildCommandPrompt,
  buildScalePrompt,
  buildTranscript,
  cleanReply,
  fallbackScale,
  parseScale,
  type TranscriptMessage,
} from '../../../app/ai_commands/prompts.std.ts';

function message(
  overrides: Partial<TranscriptMessage> & { body: string }
): TranscriptMessage {
  return {
    timestamp: 1_700_000_000_000,
    senderName: 'Sean',
    direction: 'incoming',
    attachments: [],
    quoteText: null,
    reactions: [],
    ...overrides,
  };
}

describe('ai_commands/prompts', () => {
  describe('buildTranscript', () => {
    it('renders sender, body, attachments, quotes and reactions', () => {
      const { text, included, dropped } = buildTranscript(
        [
          message({ body: 'brb', reactions: ['👍'] }),
          message({
            body: '',
            attachments: [{ contentType: 'image/jpeg' }],
            senderName: 'Me',
            direction: 'outgoing',
          }),
          message({ body: 'nice', quoteText: 'brb' }),
        ],
        { maxChars: 10_000, locale: 'en-US' }
      );
      assert.strictEqual(included, 3);
      assert.strictEqual(dropped, 0);
      assert.include(text, 'Sean: brb {reactions: 👍}');
      assert.include(text, 'Me: [photo]');
      assert.include(text, '(replying to "brb") nice');
    });

    it('drops the oldest lines first when over budget', () => {
      const messages = Array.from({ length: 20 }, (_, i) =>
        message({ body: `message number ${i}` })
      );
      const { text, included, dropped } = buildTranscript(messages, {
        maxChars: 200,
        locale: 'en-US',
      });
      assert.isAbove(dropped, 0);
      assert.strictEqual(included + dropped, 20);
      assert.include(text, 'message number 19');
      assert.notInclude(text, 'message number 0\n');
    });
  });

  describe('parseScale', () => {
    it('reads a fenced JSON array and fills gaps from the fallback', () => {
      const raw = [
        'Sure! ```json',
        JSON.stringify([
          { level: 1, title: 'Soft', description: 'A nudge about the lag.' },
          { level: 2, title: 'Dry', description: 'Deadpan about his aim.' },
          { level: 3, title: 'Jab', description: 'The feed story.' },
          { level: 4, title: 'Bite', description: 'Last night.' },
          { level: 5, title: 'Roast', description: 'Full roast.' },
          { level: 10, title: 'Nuclear', description: 'No survivors.' },
        ]),
        '```',
      ].join('\n');
      const scale = parseScale(raw, 10, 'how brutal');
      assert.isNotNull(scale);
      assert.lengthOf(scale ?? [], 10);
      assert.strictEqual(scale?.[0]?.title, 'Soft');
      assert.strictEqual(scale?.[9]?.title, 'Nuclear');
      // Level 6 came from the fallback.
      assert.strictEqual(scale?.[5]?.level, 6);
      assert.isNotEmpty(scale?.[5]?.title);
    });

    it('rejects replies with too few usable levels', () => {
      assert.isNull(parseScale('[{"level": 1, "title": "x"}]', 10, 'd'));
      assert.isNull(parseScale('not json at all', 10, 'd'));
    });

    it('ignores out-of-range or malformed entries', () => {
      const raw = JSON.stringify([
        { level: 0, title: 'bad' },
        { level: 11, title: 'bad' },
        'junk',
        ...Array.from({ length: 10 }, (_, i) => ({
          level: i + 1,
          title: `T${i + 1}`,
          description: `D${i + 1}`,
        })),
      ]);
      const scale = parseScale(raw, 10, 'd');
      assert.deepStrictEqual(
        scale?.map(entry => entry.title),
        Array.from({ length: 10 }, (_, i) => `T${i + 1}`)
      );
    });
  });

  describe('fallbackScale', () => {
    it('always returns exactly count entries numbered 1..count', () => {
      const scale = fallbackScale(7, 'intensity');
      assert.deepStrictEqual(
        scale.map(entry => entry.level),
        [1, 2, 3, 4, 5, 6, 7]
      );
      assert.strictEqual(scale[6]?.title, 'Level 7');
    });
  });

  describe('cleanReply', () => {
    it('strips think blocks, fences and wrapping quotes', () => {
      assert.strictEqual(
        cleanReply('<think>plan</think>\n"Sean, your aim is a rumor."'),
        'Sean, your aim is a rumor.'
      );
      assert.strictEqual(cleanReply('```text\nhello\n```'), 'hello');
      assert.strictEqual(cleanReply('  plain  '), 'plain');
    });
  });

  describe('buildCommandPrompt / buildScalePrompt', () => {
    it('includes the command, the level and the transcript exactly once', () => {
      const prompt = buildCommandPrompt({
        commandLabel: 'Insult Sean',
        commandPrompt: 'mrhuang, insult sean',
        conversationTitle: 'Dota squad',
        isGroup: true,
        myName: 'Dardan',
        transcript: '[Oct 24 19:02] Sean: lag',
        maxChars: 280,
        level: { level: 7, title: 'Ruthless', description: 'Go for the feed.' },
        levelCount: 10,
        levelDescribe: 'how brutal the insult is',
        extraInstructions: 'Target Sean only.',
      });
      assert.include(prompt, 'COMMAND: mrhuang, insult sean');
      assert.include(prompt, 'level 7 of 10');
      assert.include(prompt, '"Ruthless": Go for the feed.');
      assert.include(prompt, '- Target Sean only.');
      assert.strictEqual(prompt.split('[Oct 24 19:02] Sean: lag').length, 2);

      const scalePrompt = buildScalePrompt({
        commandLabel: 'Insult Sean',
        commandPrompt: 'mrhuang, insult sean',
        describe: 'how brutal the insult is',
        count: 10,
        conversationTitle: 'Dota squad',
        myName: 'Dardan',
        transcript: 'x',
      });
      assert.include(scalePrompt, 'exactly 10 objects');
      assert.include(scalePrompt, '"level": 1');
    });
  });
});
