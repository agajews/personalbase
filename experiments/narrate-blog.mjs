// Experiment: narrate the two H-Net blog posts (goombalab.github.io) as one audio file.
// Usage:
//   node experiments/narrate-blog.mjs --dry-run   # print extracted text stats + preview
//   node experiments/narrate-blog.mjs             # generate audio (resumable)
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const DRY_RUN = process.argv.includes('--dry-run');
const OUT_DIR = path.dirname(new URL(import.meta.url).pathname);
const OUT_FILE = path.join(OUT_DIR, 'hnet-blog-posts.mp3');
const PART_DIR = path.join(OUT_DIR, 'parts-hnet-blog');
const VOICE_ID = 'b24f41fd-00a3-4cd8-992a-a0c9f13f3ef1';
const CHUNK_CHARS = 2800;
const CONCURRENCY = 3;

const POSTS = [
  { file: '/tmp/hnet-past.html', intro: 'H-Nets — the Past. A blog post by Albert Gu, from the Goomba Lab blog, 2025.' },
  { file: '/tmp/hnet-future.html', intro: 'Next post: H-Nets — the Future. Also by Albert Gu, from the Goomba Lab blog, 2025.' },
];

// ---------- text extraction ----------

function speakMath(tex) {
  let s = tex;
  s = s.replace(/\\(?:mathsf|mathcal|mathbf|mathrm|text|mathit|bm|operatorname)\s*\{([^{}]*)\}/g, '$1');
  s = s.replace(/\\times/g, ' times ')
    .replace(/\\to|\\rightarrow/g, ' to ')
    .replace(/\\approx|\\sim/g, ' approximately ')
    .replace(/\\cdot/g, ' times ')
    .replace(/\\leq/g, ' at most ')
    .replace(/\\geq/g, ' at least ')
    .replace(/\\ldots|\\dots/g, '...')
    .replace(/\\%/g, ' percent')
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1 over $2')
    .replace(/\\ell/g, 'L')
    .replace(/\\theta/g, 'theta').replace(/\\alpha/g, 'alpha').replace(/\\beta/g, 'beta')
    .replace(/\\lambda/g, 'lambda').replace(/\\epsilon/g, 'epsilon').replace(/\\delta/g, 'delta');
  s = s.replace(/[\^_]/g, ' ').replace(/[{}]/g, '').replace(/\\[,;!:]/g, ' ');
  if (/\\/.test(s)) return null;
  s = s.replace(/\s+/g, ' ').trim();
  if (!s || s.length > 60) return null;
  return s;
}

function cleanPost(html) {
  let s = html.slice(html.indexOf('<d-article'), html.indexOf('</d-article>'));
  s = s.replace(/<d-contents>[\s\S]*?<\/d-contents>/g, ' ');
  s = s.replace(/<d-footnote[\s\S]*?<\/d-footnote>/g, ' ');
  s = s.replace(/<d-cite[\s\S]*?<\/d-cite>/g, ' ');
  s = s.replace(/<figure[\s\S]*?<\/figure>/g, ' ');
  // display math, then inline math
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, ' — see the equation in the post — ');
  s = s.replace(/\$([^$\n]+)\$/g, (_, tex) => {
    const spoken = speakMath(tex);
    return spoken ? ` ${spoken} ` : ' (expression) ';
  });
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g, (_, __, t) => `\n\n${t.replace(/<[^>]+>/g, '')}.\n\n`);
  s = s.replace(/<\/(p|li|div|blockquote)>/g, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#[0-9]+;/g, (m) => String.fromCodePoint(+m.slice(2, -1)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  s = s.replace(/\(\s*[;,]?\s*\)/g, ' ');
  s = s.replace(/^\s*(\[ [^\]\n]+ \]\s*)+$/gm, '');
  s = s.replace(/[•▶]/g, '');
  s = s.replace(/ +([,.;:!?])/g, '$1');
  s = s.replace(/\.{2}(?!\.)/g, '.');
  s = s.replace(/[ \t]+/g, ' ').replace(/ \n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

const parts = [];
for (const post of POSTS) {
  parts.push(post.intro);
  parts.push(cleanPost(fs.readFileSync(post.file, 'utf8')));
}
parts.push('That concludes both posts.');
const text = parts.join('\n\n');

// ---------- chunking ----------

const paragraphs = text.split(/\n\n+/);
const chunks = [];
let cur = '';
for (const p of paragraphs) {
  const sentences = p.length > CHUNK_CHARS ? p.split(/(?<=[.!?])\s+/) : [p];
  for (const s of sentences) {
    if (cur && cur.length + s.length + 2 > CHUNK_CHARS) { chunks.push(cur); cur = ''; }
    cur += (cur ? (sentences.length > 1 ? ' ' : '\n\n') : '') + s;
  }
}
if (cur) chunks.push(cur);

console.log(`extracted ${text.length} chars, ${text.split(/\s+/).length} words, ${chunks.length} chunks`);
if (DRY_RUN) {
  fs.writeFileSync(path.join(OUT_DIR, 'narration-blog.txt'), text);
  console.log('wrote experiments/narration-blog.txt for review\n--- first chunk ---\n' + chunks[0]);
  process.exit(0);
}

// ---------- TTS ----------

const env = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
const apiKey = env.match(/^CARTESIA_API_KEY=(.*)$/m)[1].trim().replace(/^"|"$/g, '');

async function tts(transcript, i) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Cartesia-Version': '2024-11-13', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_id: 'sonic-3',
        transcript,
        voice: { mode: 'id', id: VOICE_ID },
        language: 'en',
        output_format: { container: 'mp3', bit_rate: 128000, sample_rate: 44100 },
      }),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const body = await res.text();
    if (res.status === 429 || res.status >= 500) {
      console.error(`chunk ${i}: ${res.status}, retrying`);
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    throw new Error(`chunk ${i}: ${res.status} ${body}`);
  }
  throw new Error(`chunk ${i}: retries exhausted`);
}

fs.mkdirSync(PART_DIR, { recursive: true });
const partFile = (i) => path.join(PART_DIR, `part-${String(i).padStart(3, '0')}.mp3`);

let next = 0;
let failed = false;
async function worker() {
  while (next < chunks.length && !failed) {
    const i = next++;
    if (fs.existsSync(partFile(i))) { console.log(`chunk ${i + 1}/${chunks.length} already done, skipping`); continue; }
    try {
      fs.writeFileSync(partFile(i), await tts(chunks[i], i));
      console.log(`chunk ${i + 1}/${chunks.length} done`);
    } catch (e) {
      console.error(e.message);
      failed = true;
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const done = [];
for (let i = 0; i < chunks.length && fs.existsSync(partFile(i)); i++) done.push(partFile(i));
const complete = done.length === chunks.length;
const outFile = complete ? OUT_FILE : OUT_FILE.replace(/\.mp3$/, '-partial.mp3');
const listFile = path.join(PART_DIR, 'list.txt');
fs.writeFileSync(listFile, done.map((f) => `file '${f}'`).join('\n'));
execFileSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outFile], { stdio: ['ignore', 'ignore', 'inherit'] });
console.log(`saved ${outFile} (${done.length}/${chunks.length} chunks${complete ? '' : ' — rerun to finish'})`);
process.exit(complete ? 0 : 1);
