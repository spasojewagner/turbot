if (!process.env.PINECONE_INDEX_NAME) {
  throw new Error('PINECONE_INDEX_NAME is missing from environment variables');
}

export const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME;

export const PINECONE_NAME_SPACE = 'pdf-chatbot'; // or any namespace you prefer

// Vector dimensions for different embedding models
export const EMBEDDING_DIMENSIONS = {
  'text-embedding-004': 768, // Google Gemini text-embedding-004
  'openai-ada-002': 1536,    // OpenAI ada-002 (if you switch back)
};