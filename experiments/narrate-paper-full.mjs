// Experiment: narrate the full body of a paper (arXiv HTML rendering) via Cartesia TTS.
// Usage:
//   node experiments/narrate-paper-full.mjs --dry-run   # print extracted text stats + preview
//   node experiments/narrate-paper-full.mjs             # generate audio
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const DRY_RUN = process.argv.includes('--dry-run');
const HTML_PATH = '/tmp/hnet.html';
const OUT_DIR = path.dirname(new URL(import.meta.url).pathname);
const OUT_FILE = path.join(OUT_DIR, '2507.07955-dynamic-chunking-full.mp3');
const VOICE_ID = 'b24f41fd-00a3-4cd8-992a-a0c9f13f3ef1';
const CHUNK_CHARS = 2800;
const CONCURRENCY = 3;

// ---------- text extraction ----------

const html = fs.readFileSync(HTML_PATH, 'utf8');

// Convert simple LaTeX alttext to something speakable; return null if hopeless.
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
  if (/\\/.test(s)) return null; // still has unhandled LaTeX
  s = s.replace(/\s+/g, ' ').trim();
  if (!s || s.length > 60) return null;
  return s;
}

function cleanFragment(frag) {
  let s = frag;
  // figures & tables (with captions) — not narratable
  s = s.replace(/<figure[\s\S]*?<\/figure>/g, ' ');
  // display equations (LaTeXML renders as ltx_equation / ltx_eqn_table)
  s = s.replace(/<table[^>]*ltx_equation[\s\S]*?<\/table>/g, ' — see the equation in the paper — ');
  // citations and footnotes: noise when listening
  s = s.replace(/<cite[\s\S]*?<\/cite>/g, ' ');
  s = s.replace(/<span[^>]*ltx_note[\s\S]*?<\/span><\/span><\/span>/g, ' ');
  // inline math -> speakable alttext
  s = s.replace(/<math[^>]*alttext="([^"]*)"[\s\S]*?<\/math>/g, (_, alt) => {
    const spoken = speakMath(alt.replace(/&#37;/g, '%'));
    return spoken ? ` ${spoken} ` : ' (expression) ';
  });
  // headings -> spoken section breaks
  s = s.replace(/<h([2-6])[^>]*>([\s\S]*?)<\/h\1>/g, (_, __, t) => `\n\n${t.replace(/<[^>]+>/g, '')}.\n\n`);
  s = s.replace(/<\/(p|li|div)>/g, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#[0-9]+;/g, (m) => String.fromCodePoint(+m.slice(2, -1)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"');
  // leftover bracket citation shells like "( ; )" or "( )", stray bullets,
  // and space that removed cites left before punctuation
  s = s.replace(/\(\s*[;,]?\s*\)/g, ' ');
  s = s.replace(/[•▶]/g, '');
  s = s.replace(/ +([,.;:!?])/g, '$1');
  s = s.replace(/\.{2}(?!\.)/g, '.');
  s = s.replace(/[ \t]+/g, ' ').replace(/ \n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

const abstractHtml = html.match(/<div[^>]*class="ltx_abstract"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
// main body: everything from section 1 up to the acknowledgements (id="Sx1")
const bodyStart = html.indexOf('<section id="S1"');
const bodyEnd = html.indexOf('<section id="Sx1"');
const bodyHtml = html.slice(bodyStart, bodyEnd);
const parts = [
  `Dynamic Chunking for End-to-End Hierarchical Sequence Modeling. By Sukjun Hwang, Brandon Wang, and Albert Gu. Published on arXiv in July 2025.\n\nAbstract.\n\n${cleanFragment(abstractHtml).replace(/^Abstract\.?\s*/i, '')}`,
  cleanFragment(bodyHtml),
];
parts.push('This concludes the main body of the paper. References and appendices are omitted from this narration.');

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
  fs.writeFileSync(path.join(OUT_DIR, 'narration-full.txt'), text);
  console.log('wrote experiments/narration-full.txt for review\n--- first chunk ---\n' + chunks[0]);
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

// resumable: parts persist here; existing part files are skipped on rerun
const partDir = path.join(OUT_DIR, 'parts-2507.07955');
fs.mkdirSync(partDir, { recursive: true });
const partFile = (i) => path.join(partDir, `part-${String(i).padStart(3, '0')}.mp3`);

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

// stitch the contiguous prefix of finished parts
const done = [];
for (let i = 0; i < chunks.length && fs.existsSync(partFile(i)); i++) done.push(partFile(i));
const complete = done.length === chunks.length;
const outFile = complete ? OUT_FILE : OUT_FILE.replace(/\.mp3$/, '-partial.mp3');
const listFile = path.join(partDir, 'list.txt');
fs.writeFileSync(listFile, done.map((f) => `file '${f}'`).join('\n'));
execFileSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outFile], { stdio: ['ignore', 'ignore', 'inherit'] });
console.log(`saved ${outFile} (${done.length}/${chunks.length} chunks${complete ? '' : ' — rerun after topping up credits to finish'})`);
process.exit(complete ? 0 : 1);
