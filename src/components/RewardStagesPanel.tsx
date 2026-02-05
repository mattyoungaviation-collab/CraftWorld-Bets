import { useEffect, useMemo, useState } from "react";
import RewardChip from "./RewardChip";
import type { RewardItem } from "../lib/rewards";

type RewardStage = {
  requiredMasterpiecePoints: number;
  rewards?: RewardItem[] | null;
  battlePassRewards?: RewardItem[] | null;
};

type RewardStagesPanelProps = {
  rewardStages?: RewardStage[] | null;
  masterpiecePoints: number;
};

function formatInt(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

export default function RewardStagesPanel({ rewardStages, masterpiecePoints }: RewardStagesPanelProps) {
  const stages = rewardStages || [];
  const firstIncomplete = useMemo(
    () => stages.findIndex((stage) => masterpiecePoints < stage.requiredMasterpiecePoints),
    [stages, masterpiecePoints],
  );
  const [openIndex, setOpenIndex] = useState<number>(firstIncomplete >= 0 ? firstIncomplete : -1);

  useEffect(() => {
    setOpenIndex(firstIncomplete >= 0 ? firstIncomplete : -1);
  }, [firstIncomplete]);

  if (stages.length === 0) {
    return (
      <section className="card reward-panel">
        <h3>Reward Stages</h3>
        <p className="muted">No stage rewards are available.</p>
      </section>
    );
  }

  return (
    <section className="card reward-panel">
      <h3>Reward Stages</h3>
      <div className="accordion-list">
        {stages.map((stage, index) => {
          const isUnlocked = masterpiecePoints >= stage.requiredMasterpiecePoints;
          const isOpen = index === openIndex;
          const percent = stage.requiredMasterpiecePoints <= 0
            ? 100
            : Math.max(0, Math.min(100, (masterpiecePoints / stage.requiredMasterpiecePoints) * 100));

          return (
            <article key={`${stage.requiredMasterpiecePoints}-${index}`} className={`accordion-item ${isOpen ? "is-open" : ""}`}>
              <button
                type="button"
                className="accordion-header"
                onClick={() => setOpenIndex(isOpen ? -1 : index)}
              >
                <span>Tier @ {formatInt(stage.requiredMasterpiecePoints)} MP Points</span>
                <span className={`stage-status ${isUnlocked ? "is-unlocked" : "is-locked"}`}>
                  {isUnlocked ? "UNLOCKED" : "LOCKED"}
                </span>
              </button>

              {isOpen && (
                <div className="accordion-content">
                  <div className="tier-progress">
                    <div className="tier-progress__meta">
                      <span>Progress to tier</span>
                      <span>{percent.toFixed(0)}%</span>
                    </div>
                    <div className="tier-progress__bar">
                      <span style={{ width: `${percent}%` }} />
                    </div>
                  </div>

                  <div className="reward-subpanel">
                    <h4>Rewards</h4>
                    <div className="reward-chip-grid">
                      {(stage.rewards || []).map((reward, rewardIndex) => (
                        <RewardChip key={`reward-${rewardIndex}`} reward={reward} />
                      ))}
                      {(stage.rewards || []).length === 0 && <p className="muted">No rewards listed.</p>}
                    </div>
                  </div>

                  <div className="reward-subpanel">
                    <h4>BattlePass Rewards</h4>
                    <div className="reward-chip-grid">
                      {(stage.battlePassRewards || []).map((reward, rewardIndex) => (
                        <RewardChip key={`battle-pass-${rewardIndex}`} reward={reward} />
                      ))}
                      {(stage.battlePassRewards || []).length === 0 && <p className="muted">No battle pass rewards listed.</p>}
                    </div>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
