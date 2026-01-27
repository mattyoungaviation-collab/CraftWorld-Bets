import path from "path";
import serveStatic from "serve-static";
import { fileURLToPath } from "url";
import express from "express";

const app = express();
app.use(express.json());
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve the built frontend (Vite build output)
app.use(serveStatic(path.join(__dirname, "..", "dist")));


const GRAPHQL_URL = "https://craft-world.gg/graphql";

const MASTERPIECE_QUERY = `
  query Masterpiece($id: ID) {
    masterpiece(id: $id) {
      id
      name
      type
      collectedPoints
      requiredPoints
      startedAt
      leaderboard {
        position
        masterpiecePoints
        profile {
          uid
          walletAddress
          avatarUrl
          displayName
        }
      }
    }
  }
`;

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/masterpiece/:id", async (req, res) => {
  try {
    const jwt = process.env.CRAFTWORLD_JWT;
    if (!jwt) {
      return res.status(500).json({ error: "Missing CRAFTWORLD_JWT env var" });
    }

    const id = Number(req.params.id);

    const r = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        query: MASTERPIECE_QUERY,
        variables: { id },
      }),
    });

    const json = await r.json();
    if (json.errors) {
      return res.status(500).json({ error: "GraphQL error", json });
    }

    res.json(json);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 3000;
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "dist", "index.html"));
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
