/**
 * OperrAI — FAQ Ingestion Script
 * Reads faqs.json, generates OpenAI embeddings, and upserts into Supabase documents table.
 *
 * Usage:
 *   node ingest/upload.js
 *
 * Required env vars (set in your terminal before running):
 *   export OPENAI_API_KEY=sk-...
 *   export SUPABASE_URL=https://xxxx.supabase.co
 *   export SUPABASE_ANON_KEY=eyJ...
 */

const fs   = require('fs');
const path = require('path');

const OPENAI_API_KEY  = process.env.OPENAI_API_KEY  || '';
const SUPABASE_URL    = process.env.SUPABASE_URL    || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing env vars. Set OPENAI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY before running.');
  process.exit(1);
}

async function getEmbedding(text) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI embed error ${resp.status}: ${err}`);
  }
  const data = await resp.json();
  return data.data[0].embedding;
}

async function upsertDocument(doc) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/documents`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(doc),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Supabase insert error ${resp.status}: ${err}`);
  }
}

async function main() {
  const faqs = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'faqs.json'), 'utf8')
  );

  console.log(`Ingesting ${faqs.length} FAQ documents...\n`);

  for (let i = 0; i < faqs.length; i++) {
    const faq = faqs[i];
    process.stdout.write(`[${i + 1}/${faqs.length}] ${faq.doc_name} ... `);

    try {
      const embedding = await getEmbedding(faq.content);
      await upsertDocument({
        doc_name:  faq.doc_name,
        content:   faq.content,
        embedding,
        metadata:  faq.metadata || {},
      });
      console.log('done');
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }

    // Small delay to avoid OpenAI rate limits
    if (i < faqs.length - 1) await new Promise(r => setTimeout(r, 300));
  }

  console.log('\nIngestion complete. Check your Supabase documents table.');
}

main().catch(console.error);
