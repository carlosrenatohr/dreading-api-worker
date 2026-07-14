// Enrich a reading with supplementary, clearly-labeled content using the
// Workers AI binding (env.AI) — no API token needed. The readings themselves are
// never rewritten; we only add a message, reflection, kids version, discussion
// questions and an image prompt. AI failures never block ingest.

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const SYSTEM =
  'Eres un asistente católico que escribe en español, con tono reverente y cercano. ' +
  'No cites textualmente la Escritura: ofrece un comentario breve y original. ' +
  'Responde únicamente con el texto pedido.';

type Reading = Record<string, any>;
interface AiRunner {
  run(model: string, options: any): Promise<any>;
}
interface ImageStore {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: any): Promise<unknown>;
}
interface EnrichOptions {
  images?: ImageStore;
  origin?: string;
}

function gospel(reading: Reading) {
  const lecturas: Reading[] = reading.lecturas || [];
  return lecturas.find((l) => /evangelio/i.test(l?.title || '')) || lecturas[lecturas.length - 1] || {};
}

async function ask(ai: AiRunner, instruction: string, reading: Reading): Promise<string> {
  const g = gospel(reading);
  const res = await ai.run(MODEL, {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${instruction}\n\n${reading.title || ''}\n${(g.content || '').slice(0, 1500)}` },
    ],
  });
  return (res.response || '').trim();
}

// Generate a daily illustration with Flux and store it in R2; set image_url to
// the Worker route that serves it. Never blocks ingest on failure.
async function generateImage(ai: AiRunner, images: ImageStore, origin: string, reading: Reading) {
  try {
    const res = await ai.run(IMAGE_MODEL, { prompt: reading.image_prompt, steps: 4 });
    const b64: string | undefined = res && res.image;
    if (!b64) return;
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const key = `${(reading.date_raw || '').slice(0, 10)}.png`;
    await images.put(key, bytes, { httpMetadata: { contentType: 'image/png' } });
    reading.image_url = `${origin}/images/${key}`;
  } catch {
    // leave image_url unset; the reading still stores fine
  }
}

export async function enrichReading(ai: AiRunner | undefined, reading: Reading, opts: EnrichOptions = {}): Promise<Reading> {
  // Always fill a deterministic image prompt (no AI needed).
  reading.image_prompt =
    reading.image_prompt || `Ilustración reverente y luminosa, estilo cálido, de: ${gospel(reading).first_line || reading.title || ''}`;

  if (!ai) return reading; // local dev without the AI binding: store the reading as-is

  try {
    const [message, reflection, kids, questionsRaw] = await Promise.all([
      ask(ai, 'Escribe un "mensaje del día" en una sola frase inspirado en el Evangelio.', reading),
      ask(ai, 'Escribe una reflexión breve (2-3 frases) que conecte el Evangelio con la vida diaria.', reading),
      ask(ai, 'Explica el Evangelio de hoy para un niño pequeño, en 1-2 frases sencillas.', reading),
      ask(ai, 'Propón dos preguntas breves para reflexionar en familia. Una por línea, sin numerar.', reading),
    ]);
    if (message) reading.message = message;
    if (reflection) reading.reflection = reflection;
    if (kids) reading.kids_reflection = kids;
    const questions = questionsRaw
      .split('\n')
      .map((line) => line.replace(/^[-•\d.\s]+/, '').trim())
      .filter(Boolean)
      .slice(0, 2);
    if (questions.length) reading.questions = questions;
  } catch {
    // Keep whatever we have; a failed enrichment must not drop the reading.
  }

  if (opts.images && opts.origin) {
    await generateImage(ai, opts.images, opts.origin, reading);
  }
  return reading;
}
