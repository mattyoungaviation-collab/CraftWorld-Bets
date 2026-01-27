import { useEffect, useMemo, useState } from "react";
import "./App.css";

type LeaderRow = {
  position: number;
  masterpiecePoints: number;
  profile: {
    uid: string;
    walletAddress?: string | null;
    avatarUrl?: string | null;
    displayName?: string | null;
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

function fmt(n: number) {
  return n.toLocaleString();
}

export default function App() {
  const [username, setUsername] = useState(() => localStorage.getItem("cw_bets_user") || "");
  const [mpId, setMpId] = useState<number>(55);
  const [mp, setMp] = useState<Masterpiece | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");
  const [selectedPos, setSelectedPos] = useState<1 | 2 | 3>(1);
  const [amount, setAmount] = useState<number>(50000);
  const [placing, setPlacing] = useState(false);
  const [toast, setToast] = useState<string>("");

  useEffect(() => {
    localStorage.setItem("cw_bets_user", username);
  }, [username]);

  async function loadMasterpiece(id: number) {
    setLoading(true);
    setErr("");
    try {
      const r = await fetch(`/api/masterpiece/${id}`);
      const j = await r.json();
      const m = j?.data?.masterpiece as Masterpiece | undefined;
      if (!m) throw new Error("No masterpiece data returned");
      setMp(m);
    } catch (e: any) {
      setErr(e?.message || String(e));
      setMp(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadMasterpiece(mpId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const top100 = useMemo(() => (mp?.leaderboard || []).slice(0, 100), [mp]);

  async function placeBet(picked: LeaderRow) {
    if (!username.trim()) {
      setToast("Type a username first.");
      return;
    }
    setPlacing(true);
    setToast("");
    try {
      const payload = {
        user: username.trim(),
        masterpieceId: mpId,
        position: selectedPos,
        pickedUid: picked.profile.uid,
        amount: Math.floor(Number(amount)),
      };

      const r = await fetch("/api/bets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      const j = await r.json();
      if (!r.ok || j?.ok !== true) {
        throw new Error(j?.error || "Failed to place bet");
      }

      setToast(
        `✅ Bet placed: ${payload.user} → #${payload.position} = ${picked.profile.displayName || picked.profile.uid} (${fmt(
          payload.amount
        )})`
      );
    } catch (e: any) {
      setToast(`❌ ${e?.message || String(e)}`);
    } finally {
      setPlacing(false);
    }
  }

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 16, fontFamily: "system-ui, Arial" }}>
      <h1 style={{ margin: "8px 0 4px" }}>CraftWorld Bets</h1>
      <div style={{ opacity: 0.8, marginBottom: 12 }}>Click a player to place a bet (Position 1/2/3 markets)</div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 140px 140px 140px", gap: 10, alignItems: "end" }}>
        <div>
          <label style={{ fontSize: 12, opacity: 0.75 }}>Username (user-created)</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="e.g. MattTheBookie"
            style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid #ddd" }}
          />
        </div>

        <div>
          <label style={{ fontSize: 12, opacity: 0.75 }}>Masterpiece ID</label>
          <input
            type="number"
            value={mpId}
            onChange={(e) => setMpId(Number(e.target.value))}
            style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid #ddd" }}
          />
        </div>

        <div>
          <label style={{ fontSize: 12, opacity: 0.75 }}>Bet Position</label>
          <select
            value={selectedPos}
            onChange={(e) => setSelectedPos(Number(e.target.value) as 1 | 2 | 3)}
            style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid #ddd" }}
          >
            <option value={1}>#1</option>
            <option value={2}>#2</option>
            <option value={3}>#3</option>
          </select>
        </div>

        <div>
          <label style={{ fontSize: 12, opacity: 0.75 }}>Amount</label>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid #ddd" }}
          />
        </div>
      </div>

      <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center" }}>
        <button
          onClick={() => loadMasterpiece(mpId)}
          disabled={loading}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #ddd",
            background: "white",
            cursor: "pointer",
          }}
        >
          {loading ? "Refreshing..." : "Refresh Leaderboard"}
        </button>
        <div style={{ fontSize: 13, opacity: 0.8 }}>
          Tip: click any row below to place your bet using the current Position + Amount.
        </div>
      </div>

      {toast && (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 12, border: "1px solid #ddd" }}>
          {toast}
        </div>
      )}

      {err && (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 12, border: "1px solid #f3c0c0" }}>
          <b>Error:</b> {err}
        </div>
      )}

      <div style={{ marginTop: 16, padding: 14, borderRadius: 14, border: "1px solid #eee" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Masterpiece</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{mp ? `${mp.name} (ID ${mp.id})` : "—"}</div>
            {mp && <div style={{ opacity: 0.8 }}>{mp.type}</div>}
          </div>
          {mp && (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Progress</div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>
                {fmt(mp.collectedPoints)} / {fmt(mp.requiredPoints)}
              </div>
            </div>
          )}
        </div>
      </div>

      <h2 style={{ marginTop: 16 }}>Leaderboard (click to bet)</h2>

      <div style={{ border: "1px solid #eee", borderRadius: 14, overflow: "hidden" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "80px 1fr 180px 120px",
            gap: 0,
            padding: "10px 12px",
            fontSize: 12,
            opacity: 0.7,
            borderBottom: "1px solid #eee",
            background: "#fafafa",
          }}
        >
          <div>Pos</div>
          <div>Player</div>
          <div>Points</div>
          <div></div>
        </div>

        {top100.map((row) => {
          const name = row.profile.displayName || row.profile.uid;
          const avatar = row.profile.avatarUrl || "";
          return (
            <button
              key={`${row.position}-${row.profile.uid}`}
              onClick={() => placeBet(row)}
              disabled={placing}
              style={{
                width: "100%",
                textAlign: "left",
                border: "none",
                background: "white",
                padding: 0,
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "80px 1fr 180px 120px",
                  alignItems: "center",
                  padding: "10px 12px",
                  borderBottom: "1px solid #f3f3f3",
                }}
              >
                <div style={{ fontWeight: 700 }}>#{row.position}</div>

                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {avatar ? (
                    <img
                      src={avatar}
                      alt=""
                      style={{ width: 32, height: 32, borderRadius: 10, objectFit: "cover" }}
                      onError={(e) => ((e.currentTarget.style.display = "none"))}
                    />
                  ) : (
                    <div style={{ width: 32, height: 32, borderRadius: 10, background: "#eee" }} />
                  )}
                  <div>
                    <div style={{ fontWeight: 700 }}>{name}</div>
                    <div style={{ fontSize: 12, opacity: 0.65 }}>{row.profile.uid}</div>
                  </div>
                </div>

                <div style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(row.masterpiecePoints)}</div>

                <div style={{ textAlign: "right", opacity: 0.7 }}>
                  {placing ? "Placing..." : `Bet #${selectedPos}`}
                </div>
              </div>
            </button>
          );
        })}

        {!loading && top100.length === 0 && (
          <div style={{ padding: 12, opacity: 0.7 }}>No leaderboard rows returned.</div>
        )}
      </div>
    </div>
  );
}
