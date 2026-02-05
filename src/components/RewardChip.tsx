import { formatReward, type RewardItem } from "../lib/rewards";

type RewardChipProps = {
  reward: RewardItem;
};

const ICON_BY_TYPE: Record<string, string> = {
  Resource: "◈",
  Badge: "🏷",
  BoosterItem: "⚡",
  TradePack: "📦",
  BuildingReward: "🏛",
  PowerPack: "🔋",
  Avatar: "👤",
};

export default function RewardChip({ reward }: RewardChipProps) {
  const formatted = formatReward(reward);
  const icon = ICON_BY_TYPE[reward.__typename || ""] || "🎁";

  return (
    <article className="reward-chip">
      <div className="reward-chip__top">
        <span className="reward-chip__icon" aria-hidden="true">{icon}</span>
        <span className="reward-chip__tag">{formatted.tag}</span>
      </div>
      <strong className="reward-chip__label">{formatted.label}</strong>
      {formatted.sublabel && <span className="reward-chip__sublabel">{formatted.sublabel}</span>}
      {formatted.link && (
        <a href={formatted.link} target="_blank" rel="noreferrer" className="reward-chip__link">
          {formatted.linkLabel || "View"}
        </a>
      )}
    </article>
  );
}
