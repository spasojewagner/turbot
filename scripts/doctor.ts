import { Pinecone } from '@pinecone-database/pinecone';

const geminiKey = process.env.GEMINI_API_KEY;
const pineconeKey = process.env.PINECONE_API_KEY;
const indexName = process.env.PINECONE_INDEX_NAME;

console.log('ENV:');
console.log('  GEMINI_API_KEY   ', geminiKey ? `${geminiKey.slice(0, 8)}... (${geminiKey.length})` : 'FALI');
console.log('  PINECONE_API_KEY ', pineconeKey ? `${pineconeKey.slice(0, 8)}... (${pineconeKey.length})` : 'FALI');
console.log('  PINECONE_INDEX   ', indexName ?? 'FALI');

console.log('\nPINECONE:');
try {
  const pc = new Pinecone({ apiKey: pineconeKey! });
  const { indexes = [] } = await pc.listIndexes();
  if (!indexes.length) console.log('  nema nijednog indeksa');
  for (const i of indexes) {
    console.log(`  ${i.name} — dim ${i.dimension}, ${i.metric}, ${i.status?.state}`);
  }
  if (indexes.some((i) => i.name === indexName)) {
    const s = await pc.Index(indexName!).describeIndexStats();
    console.log(`  vektora u "${indexName}": ${s.totalRecordCount ?? 0}`);
    console.log('  namespace-ovi:', Object.keys(s.namespaces ?? {}).join(', ') || '(prazno)');
  } else {
    console.log(`  index "${indexName}" NE POSTOJI`);
  }
} catch (e) {
  console.log('  GRESKA:', e instanceof Error ? e.message : e);
}

console.log('\nGEMINI:');
try {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`);
  if (!res.ok) {
    console.log(`  HTTP ${res.status} — kljuc nije validan`);
  } else {
    const data = (await res.json()) as { models?: { name: string }[] };
    const names = (data.models ?? []).map((m) => m.name.replace('models/', ''));
    console.log(`  ukupno ${names.length} modela`);
    console.log('  embedding:', names.filter((n) => n.includes('embedding')).join(', '));
    console.log('  flash:', names.filter((n) => n.includes('flash')).slice(0, 10).join(', '));
    for (const m of ['gemini-1.5-flash', 'text-embedding-004', 'gemini-2.5-flash', 'gemini-embedding-001']) {
      console.log(`  ${names.includes(m) ? 'IMA        ' : 'NEMA       '} ${m}`);
    }
  }
} catch (e) {
  console.log('  GRESKA:', e instanceof Error ? e.message : e);
}