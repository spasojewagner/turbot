import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';

const embeddings = new GoogleGenerativeAIEmbeddings({
  apiKey: process.env.GEMINI_API_KEY!,
  model: process.env.EMBEDDING_MODEL ?? 'gemini-embedding-001',
});

const vectors = await embeddings.embedDocuments([
  'Rim Avio Prvi Maj\n\nHotel 3* cena 699 evra',
  'druga proba',
]);

vectors.forEach((v, i) => console.log(`${i}: dužina ${v.length}`));
console.log('je li niz:', Array.isArray(vectors));
console.log('dužina:', vectors?.length);
console.log('sirovo:', JSON.stringify(vectors)?.slice(0, 200));