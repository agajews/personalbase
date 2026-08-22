// Experiment: narrate a paper from the library out loud via Cartesia TTS.
// Usage: node experiments/narrate-paper.mjs
import fs from 'fs';
import path from 'path';

const env = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
const apiKey = env.match(/^CARTESIA_API_KEY=(.*)$/m)[1].trim().replace(/^"|"$/g, '');

const VOICE_ID = 'b24f41fd-00a3-4cd8-992a-a0c9f13f3ef1';

const transcript = `
Dynamic Chunking for End-to-End Hierarchical Sequence Modeling.
By Sukjun Hwang, Brandon Wang, and Albert Gu. Published on arXiv in July 2025.

Major progress on language models in recent years has largely resulted from moving away from specialized models designed for specific tasks, to general models based on powerful architectures, such as the Transformer, that learn everything from raw data. Despite this trend, pre-processing steps such as tokenization remain a barrier to true end-to-end foundation models.

The authors introduce a collection of new techniques that enable a dynamic chunking mechanism, which automatically learns content- and context-dependent segmentation strategies, learned jointly with the rest of the model. Incorporating this into an explicit hierarchical network, called the H-Net, allows replacing the implicitly hierarchical tokenization, language modeling, and detokenization pipeline with a single model learned fully end-to-end.

When compute- and data-matched, an H-Net with one stage of hierarchy operating at the byte level outperforms a strong Transformer language model operating over B P E tokens. Iterating the hierarchy to multiple stages further increases its performance by modeling multiple levels of abstraction, demonstrating significantly better scaling with data, and matching the token-based Transformer of twice its size.

H-Nets pretrained on English show significantly increased character-level robustness, and qualitatively learn meaningful, data-dependent chunking strategies without any heuristics or explicit supervision.

Finally, the H-Net's improvement over tokenized pipelines is further increased in languages and modalities with weaker tokenization heuristics, such as Chinese and code, or DNA sequences, where it shows a nearly four-times improvement in data efficiency over baselines. This demonstrates the potential of true end-to-end models that learn and scale better from unprocessed data.
`.trim();

async function tts(modelId) {
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Cartesia-Version': '2024-11-13',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: modelId,
      transcript,
      voice: { mode: 'id', id: VOICE_ID },
      language: 'en',
      output_format: { container: 'mp3', bit_rate: 128000, sample_rate: 44100 },
    }),
  });
  if (!res.ok) throw new Error(`${modelId}: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

let audio;
for (const model of ['sonic-3', 'sonic-2']) {
  try {
    audio = await tts(model);
    console.log(`generated with ${model}`);
    break;
  } catch (e) {
    console.error(e.message);
  }
}
if (!audio) process.exit(1);

const out = path.join(path.dirname(new URL(import.meta.url).pathname), '2507.07955-dynamic-chunking.mp3');
fs.writeFileSync(out, audio);
console.log(`saved ${out} (${(audio.length / 1024).toFixed(0)} KB)`);
