import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';

const embeddings = new GoogleGenerativeAIEmbeddings({
  apiKey: process.env.GEMINI_API_KEY!,
  model: process.env.EMBEDDING_MODEL ?? 'gemini-embedding-001',
});

const vector = await embeddings.embedQuery('test rečenica za merenje dimenzija');
console.log(`model: ${process.env.EMBEDDING_MODEL}`);
console.log(`dimenzija: ${vector.length}`);