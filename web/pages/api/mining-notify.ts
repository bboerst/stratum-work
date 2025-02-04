import type { NextApiRequest, NextApiResponse } from "next";
import { MongoClient } from "mongodb";

const username = process.env.MONGODB_USERNAME;
const password = process.env.MONGODB_PASSWORD;
const host = process.env.MONGODB_URL || "mongodb://mongodb:27017";
const dbName = process.env.MONGODB_DB || "stratum-logger";

// Build a connection URI that includes credentials if provided.
const uri =
  username && password
    ? host.replace("mongodb://", `mongodb://${username}:${password}@`)
    : host;

let cachedClient: MongoClient | null = null;
let cachedDb: any = null;

async function connectToDatabase() {
  if (cachedClient && cachedDb) {
    return { client: cachedClient, db: cachedDb };
  }
  const client = await MongoClient.connect(uri);
  const db = client.db(dbName);
  cachedClient = client;
  cachedDb = db;
  return { client, db };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { height } = req.query;
  if (!height) {
    res.status(400).json({ error: "Missing block height" });
    return;
  }
  try {
    const { db } = await connectToDatabase();
    const records = await db
      .collection("mining_notify")
      .find({ height: parseInt(height as string) })
      .toArray();
    res.status(200).json(records);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}