/**
 * OperrAI — FAQ Ingestion Script
 * Reads faqs.json, generates OpenAI embeddings, and upserts into Supabase documents table.
 * Safe to re-run: uses doc_id for deduplication (existing rows are updated, not duplicated).
 *
 * FAQ JSON format (each entry):
 *   {
 *     "doc_id":   "unique-slug",          ← stable ID for upsert deduplication (required)
 *     "doc_name": "Category - Sub-topic", ← shown as source citation in the chat UI
 *     "content":  "Question: …\n\nAnswer: …"  ← include the question for better semantic search
 *   }
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

const OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || '';
const SUPABASE_URL      = process.env.SUPABASE_URL      || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing env vars. Set OPENAI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY before running.');
  process.exit(1);
}

/** Convert a string to a URL-safe slug, used to auto-generate doc_id if missing. */
function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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
  // ?on_conflict=doc_id tells Supabase to UPDATE the existing row when doc_id already exists.
  // This makes re-runs safe — no duplicates.
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/documents?on_conflict=doc_id`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(doc),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Supabase upsert error ${resp.status}: ${err}`);
  }
  const saved = await resp.json();
  return Array.isArray(saved) ? saved[0] : saved;
}

async function main() {
  const faqs = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'faqs.json'), 'utf8')
  );

  console.log(`Ingesting ${faqs.length} FAQ documents into Supabase…\n`);

  let ok = 0, fail = 0;
  for (let i = 0; i < faqs.length; i++) {
    const faq = faqs[i];
    const doc_id = faq.doc_id || slugify(faq.doc_name);
    process.stdout.write(`[${i + 1}/${faqs.length}] ${doc_id} … `);

    try {
      const embedding = await getEmbedding(faq.content);
      const saved = await upsertDocument({
        doc_id,
        doc_name:  faq.doc_name,
        content:   faq.content,
        embedding,
        metadata:  faq.metadata || {},
      });
      console.log(`done (db id: ${saved?.id ?? '?'})`);
      ok++;
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      fail++;
    }

    // Small delay to avoid OpenAI rate limits
    if (i < faqs.length - 1) await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nIngestion complete: ${ok} upserted, ${fail} failed.`);
  if (fail > 0) console.log('Re-run the script to retry failed entries — it is safe to re-run.');
}

main().catch(console.error);
