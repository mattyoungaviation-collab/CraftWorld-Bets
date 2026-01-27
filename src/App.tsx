import { useEffect, useMemo, useState } from "react";
import "./App.css";

type LeaderRow = {
  position: number;
  masterpiecePoints: number;
  profile: {
    uid: string;
    walletAddress: string;
    avatarUrl: string | null;
    displayName: string | null;
  };
};

type Masterpiece = {
  id: string;
  name: string;
  type: string;
  collectedPoints: number;
  requiredPoints: number;
  startedAt: string;
  leaderboard: LeaderRow[];
};

function formatNumber(n: number) {
  return n.toLocaleString("en-US");
}

function safeName(row: LeaderRow) {
  return row.profile?.displayName || row.profile?.uid || "Unknown";
}

function pct(collected: number, required: number) {
  if (!required) return 0;
  return Math.max(0, Math.min(100, (collected / required) * 100));
}

export default function App() {
  const [mpId, setMpId] = useState<string>("55");
  const [data, setData] = useState<Masterpiece | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // auto-refresh every 15s
  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        setLoading(true);
        setErr(null);

        const r = await fetch(`/api/masterpiece/${mpId}`);
        const json = await r.json();

        const mp: Masterpiece | undefined = json?.data?.masterpiece;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (!mp) throw new Error("No masterpiece returned");

        if (alive) setData(mp);
      } catch (e: any) {
        if (alive) setErr(e?.message || String(e));
      } finally {
        if (alive) setLoading(false);
      }
    }

    load();
    const t = setInterval(load, 15000);

    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [mpId]);

  const leaderboard = useMemo(() => data?.leaderboard || [], [data]);
  const top3 = leaderboard.filter((x) => x.position >= 1 && x.position <= 3);
  const progress = data ? pct(data.collectedPoints, data.requiredPoints) : 0;

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 16 }}>
      <header style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>CraftWorld Bets (Off-chain)</h2>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 14 }}>
            Masterpiece ID{" "}
            <input
              value={mpId}
              onChange={(e) => setMpId(e.target.value)}
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid #ddd",
                width: 120,
              }}
            />
          </label>
          <span style={{ fontSize: 12, opacity: 0.7 }}>
            refresh: 15s
          </span>
        </div>
      </header>

      <div style={{ marginTop: 12, padding: 14, border: "1px solid #eee", borderRadius: 14 }}>
        {loading && !data ? <div>Loading…</div> : null}
        {err ? (
          <div style={{ color: "crimson" }}>
            Error: {err}
          </div>
        ) : null}

        {data ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>Masterpiece</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{data.name}</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  ID {data.id} • {data.type}
                </div>
              </div>

              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12, opacity: 0.7 }}>Progress</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>
                  {progress.toFixed(2)}%
                </div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  {formatNumber(data.collectedPoints)} / {formatNumber(data.requiredPoints)}
                </div>
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <div style={{ height: 12, background: "#f1f1f1", borderRadius: 999, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${progress}%`, background: "#111" }} />
              </div>
            </div>
          </>
        ) : null}
      </div>

      <section style={{ marginTop: 16 }}>
        <h3 style={{ margin: "12px 0" }}>Top 3 (Bettable)</h3>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
          {top3.map((row) => (
            <div
              key={row.position}
              style={{
                border: "1px solid #eee",
                borderRadius: 16,
                padding: 14,
                display: "flex",
                gap: 12,
                alignItems: "center",
              }}
            >
              <div style={{ fontSize: 18, fontWeight: 800, width: 36 }}>#{row.position}</div>

              <img
                src={row.profile?.avatarUrl || "https://craft-world.gg/avatars/dyn-0.png"}
                alt=""
                style={{ width: 44, height: 44, borderRadius: 12, objectFit: "cover" }}
              />

              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>{safeName(row)}</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  {formatNumber(row.masterpiecePoints)} pts
                </div>
              </div>

              <button
                onClick={() => alert(`Bet UI next: ${safeName(row)} for #${row.position}`)}
                style={{
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid #ddd",
                  background: "white",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                Bet
              </button>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginTop: 18 }}>
        <h3 style={{ margin: "12px 0" }}>Leaderboard</h3>

        <div style={{ border: "1px solid #eee", borderRadius: 14, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 180px", padding: 12, fontSize: 12, fontWeight: 700, background: "#fafafa" }}>
            <div>Pos</div>
            <div>Name</div>
            <div style={{ textAlign: "right" }}>Points</div>
          </div>

          {leaderboard.slice(0, 100).map((row) => (
            <div
              key={`${row.position}-${row.profile?.uid}`}
              style={{
                display: "grid",
                gridTemplateColumns: "80px 1fr 180px",
                padding: 12,
                borderTop: "1px solid #f0f0f0",
                alignItems: "center",
              }}
            >
              <div>#{row.position}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <img
                  src={row.profile?.avatarUrl || "https://craft-world.gg/avatars/dyn-0.png"}
                  alt=""
                  style={{ width: 28, height: 28, borderRadius: 8, objectFit: "cover" }}
                />
                <span>{safeName(row)}</span>
              </div>
              <div style={{ textAlign: "right" }}>{formatNumber(row.masterpiecePoints)}</div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
          Showing top 100 • Data source: Craft World GraphQL via server JWT
        </div>
      </section>
    </div>
  );
}
