// Enrich a reading with supplementary, clearly-labeled content using the
// Workers AI binding (env.AI) — no API token needed. The readings themselves are
// never rewritten; we only add a message, reflection, kids version, discussion
// questions and an image prompt. AI failures never block ingest.

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const SYSTEM =
  'Eres un asistente católico que escribe en español, con tono reverente y cercano. ' +
  'No cites textualmente la Escritura: ofrece un comentario breve y original. ' +
  'Responde únicamente con el texto pedido.';

type Reading = Record<string, any>;
interface AiRunner {
  run(model: string, options: { messages: { role: string; content: string }[] }): Promise<{ response?: string }>;
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

export async function enrichReading(ai: AiRunner | undefined, reading: Reading): Promise<Reading> {
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
  return reading;
}
