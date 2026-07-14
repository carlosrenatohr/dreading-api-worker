import { describe, it, expect } from 'vitest';

import { enrichReading } from '../src/enrich';

const reading = () => ({
  date_raw: '2026-07-19T00:00:00Z',
  title: 'Domingo XVI',
  lecturas: [
    { title: 'Primera Lectura', content: '...' },
    { title: 'Evangelio', content: 'En aquel tiempo...', first_line: 'Lectura del santo evangelio' },
  ],
});

// A fake Workers AI binding: echoes which instruction it received.
const fakeAi = {
  run: async (_model: string, opts: any) => {
    if (opts.prompt) return { image: 'aGVsbG8=' }; // Flux → base64 ("hello")
    const instruction = opts.messages[1].content.split('\n')[0];
    if (instruction.includes('preguntas')) return { response: '¿Qué te dice?\n¿Cómo lo vives?' };
    return { response: `salida: ${instruction.slice(0, 15)}` };
  },
};

describe('enrichReading', () => {
  it('fills message, reflection, kids, questions and image prompt via the AI binding', async () => {
    const r = await enrichReading(fakeAi, reading());
    expect(r.message).toBeTruthy();
    expect(r.reflection).toBeTruthy();
    expect(r.kids_reflection).toBeTruthy();
    expect(r.questions).toEqual(['¿Qué te dice?', '¿Cómo lo vives?']);
    expect(r.image_prompt).toContain('evangelio');
  });

  it('generates and stores an image in R2 when the binding is present', async () => {
    const puts: { key: string }[] = [];
    const images = { put: async (key: string) => { puts.push({ key }); } };
    const r = await enrichReading(fakeAi, reading(), { images, origin: 'https://w.dev' });
    expect(puts).toEqual([{ key: '2026-07-19.png' }]);
    expect(r.image_url).toBe('https://w.dev/images/2026-07-19.png');
  });

  it('without an AI binding, stores the reading as-is (only the image prompt)', async () => {
    const r = await enrichReading(undefined, reading());
    expect(r.reflection).toBeUndefined();
    expect(r.image_prompt).toBeTruthy();
  });

  it('AI failure does not drop the reading', async () => {
    const boom = { run: async () => { throw new Error('AI down'); } };
    const r = await enrichReading(boom, reading());
    expect(r.date_raw).toBe('2026-07-19T00:00:00Z');
    expect(r.image_prompt).toBeTruthy();
  });
});
