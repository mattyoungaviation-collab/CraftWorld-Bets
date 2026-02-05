import { useState } from "react";
import type { RewardItem } from "../lib/rewards";
import RewardChip from "./RewardChip";

type LeaderboardReward = {
  top: number;
  rewards?: RewardItem[] | null;
};

type LeaderboardRewardsPanelProps = {
  leaderboardRewards?: LeaderboardReward[] | null;
};

export default function LeaderboardRewardsPanel({ leaderboardRewards }: LeaderboardRewardsPanelProps) {
  const items = leaderboardRewards || [];
  const [openIndex, setOpenIndex] = useState<number>(-1);

  if (items.length === 0) {
    return (
      <section className="card reward-panel">
        <h3>Leaderboard Rewards</h3>
        <p className="muted">No leaderboard rewards are available.</p>
      </section>
    );
  }

  return (
    <section className="card reward-panel">
      <h3>Leaderboard Rewards</h3>
      <div className="accordion-list">
        {items.map((rewardBracket, index) => {
          const isOpen = index === openIndex;
          return (
            <article key={`${rewardBracket.top}-${index}`} className={`accordion-item ${isOpen ? "is-open" : ""}`}>
              <button
                type="button"
                className="accordion-header"
                onClick={() => setOpenIndex(isOpen ? -1 : index)}
              >
                <span>Top {rewardBracket.top}</span>
              </button>
              {isOpen && (
                <div className="accordion-content">
                  <div className="reward-chip-grid">
                    {(rewardBracket.rewards || []).map((reward, rewardIndex) => (
                      <RewardChip key={`leaderboard-${index}-reward-${rewardIndex}`} reward={reward} />
                    ))}
                    {(rewardBracket.rewards || []).length === 0 && <p className="muted">No rewards listed.</p>}
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
