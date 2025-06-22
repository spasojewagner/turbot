import { Pinecone } from '@pinecone-database/pinecone';

if (!process.env.PINECONE_API_KEY) {
  throw new Error('Pinecone API key is missing');
}

if (!process.env.PINECONE_INDEX_NAME) {
  throw new Error('Pinecone index name is missing');
}


let pineconeInstance: Pinecone | null = null;

export async function getPineconeClient(): Promise<Pinecone> {
  if (pineconeInstance) {
    return pineconeInstance;
  }

  try {
    pineconeInstance = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY!,
    });

    return pineconeInstance;
  } catch (error) {
    console.log('Error initializing Pinecone client:', error);
    throw new Error('Failed to initialize Pinecone Client');
  }
}

export async function getPineconeIndex() {
  try {
    const pinecone = await getPineconeClient();
    const index = pinecone.Index(process.env.PINECONE_INDEX_NAME!);
    return index;
  } catch (error) {
    console.log('Error getting Pinecone index:', error);
    throw new Error('Failed to get Pinecone index');
  }
}